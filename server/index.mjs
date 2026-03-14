import {
    createPrivateKey,
    createSign,
    generateKeyPairSync,
    randomUUID,
} from 'node:crypto';
import {
    readFile,
    writeFile,
} from 'node:fs/promises';

const MODULE_NAME = '[TavernNotify]';
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const WEB_PUSH_TITLE = '酒馆后台通知';
const WEB_PUSH_SUCCESS_BODY = '回复已生成，请回到酒馆查看。';
const WEB_PUSH_FAILURE_BODY = '后台生成失败，请回到酒馆查看。';
const WEB_PUSH_TTL_SECONDS = 60;
const WEB_PUSH_SUBJECT = 'mailto:tavern-notify@localhost';
const WEB_PUSH_STATE_FILE = new URL('./webpush-state.json', import.meta.url);
const WEB_PUSH_SW_FILE = new URL('./sw.js', import.meta.url);
const FORWARDED_HEADER_NAMES = ['authorization', 'cookie', 'user-agent', 'x-csrf-token'];

const ENDPOINTS = {
    openai: '/api/backends/chat-completions/generate',
    textgenerationwebui: '/api/backends/text-completions/generate',
    kobold: '/api/backends/kobold/generate',
    koboldhorde: '/api/backends/koboldhorde/generate',
    novel: '/api/novelai/generate',
};

const jobs = new Map();
const debugOwners = new Set();
const webPushSubscriptions = new Map();
const webPushPendingNotifications = new Map();

let cleanupTimer = null;
let webPushStatePromise = null;
let webPushVapid = null;

export const info = {
    id: 'tavern-notify',
    name: 'Tavern Notify',
    description: 'Runs compatible SillyTavern generations in the background and pushes Bark or Web Push notifications on completion.',
};

export async function init(router) {
    router.get('/probe', (_request, response) => {
        return response.sendStatus(204);
    });

    router.post('/debug-mode', (request, response) => {
        const owner = getOwnerKey(request);
        const enabled = request.body?.enabled === true;
        setDebugMode(owner, enabled);
        return response.json({ ok: true, enabled });
    });

    router.post('/jobs', async (request, response) => {
        try {
            const payload = normalizeCreatePayload(request.body);
            const job = createJob(request, payload);
            jobs.set(job.id, job);
            jobLog(job, 'Created background job.', {
                endpoint: job.endpoint,
                notificationChannel: job.jobMeta.notificationChannel,
            });
            void runJob(job);
            return response.status(202).json(publicJob(job));
        } catch (error) {
            return response.status(400).json({
                error: true,
                message: error instanceof Error ? error.message : 'Failed to create background job.',
            });
        }
    });

    router.get('/jobs/:jobId', (request, response) => {
        const job = jobs.get(String(request.params.jobId || ''));
        if (!job || job.owner !== getOwnerKey(request)) {
            return response.status(404).json({ error: true, message: 'Job not found.' });
        }

        return response.json(publicJob(job, { includeResult: true }));
    });

    router.post('/jobs/:jobId/ack', (request, response) => {
        const jobId = String(request.params.jobId || '');
        const job = jobs.get(jobId);
        if (!job || job.owner !== getOwnerKey(request)) {
            return response.status(404).json({ error: true, message: 'Job not found.' });
        }

        jobs.delete(jobId);
        return response.sendStatus(204);
    });

    router.post('/notify-test', async (request, response) => {
        try {
            const bark = sanitizeBarkConfig(request.body?.bark);
            if (!bark) {
                throw new Error('Bark settings are required to send a test notification.');
            }

            await sendBarkNotification({
                bark,
                jobMeta: sanitizeJobMeta(request.body?.jobMeta),
                failed: false,
                bodyText: String(request.body?.message || '这是一条 Bark 测试通知。'),
            });

            return response.json({ ok: true });
        } catch (error) {
            return response.status(400).json({
                error: true,
                message: error instanceof Error ? error.message : 'Failed to send Bark test notification.',
            });
        }
    });

    router.get('/webpush/config', async (_request, response) => {
        try {
            const vapid = await ensureWebPushState();
            return response.json({
                publicKey: vapid.publicKey,
            });
        } catch (error) {
            return response.status(500).json({
                error: true,
                message: error instanceof Error ? error.message : 'Failed to load Web Push config.',
            });
        }
    });

    router.get('/webpush/sw.js', async (_request, response) => {
        try {
            const source = await readFile(WEB_PUSH_SW_FILE, 'utf8');
            response.setHeader('content-type', 'application/javascript; charset=utf-8');
            response.setHeader('cache-control', 'no-store');
            response.setHeader('service-worker-allowed', '/');
            return response.send(source);
        } catch (error) {
            return response.status(500).json({
                error: true,
                message: error instanceof Error ? error.message : 'Failed to load Web Push service worker.',
            });
        }
    });

    router.post('/webpush/subscribe', async (request, response) => {
        try {
            const owner = getOwnerKey(request);
            const subscription = sanitizeWebPushSubscription(request.body?.subscription);
            await ensureWebPushState();
            await upsertWebPushSubscription(owner, subscription);
            debugLog(owner, 'Saved Web Push subscription.', {
                endpoint: subscription.endpoint,
            });
            return response.json({
                ok: true,
                endpoint: subscription.endpoint,
            });
        } catch (error) {
            return response.status(400).json({
                error: true,
                message: error instanceof Error ? error.message : 'Failed to save Web Push subscription.',
            });
        }
    });

    router.post('/webpush/unsubscribe', async (request, response) => {
        try {
            const owner = getOwnerKey(request);
            const endpoint = normalizeString(request.body?.endpoint);
            if (!endpoint) {
                throw new Error('Missing Web Push endpoint.');
            }

            await ensureWebPushState();
            await removeWebPushSubscription(owner, endpoint);
            debugLog(owner, 'Removed Web Push subscription.', { endpoint });
            return response.json({ ok: true });
        } catch (error) {
            return response.status(400).json({
                error: true,
                message: error instanceof Error ? error.message : 'Failed to remove Web Push subscription.',
            });
        }
    });

    router.get('/webpush/pull', async (request, response) => {
        try {
            const owner = getOwnerKey(request);
            const endpoint = normalizeString(request.query?.endpoint);
            if (!endpoint) {
                throw new Error('Missing Web Push endpoint.');
            }

            const notifications = pullWebPushNotifications(owner, endpoint);
            debugLog(owner, 'Pulled queued Web Push notifications.', {
                endpoint,
                count: notifications.length,
            });
            return response.json({ notifications });
        } catch (error) {
            return response.status(400).json({
                error: true,
                message: error instanceof Error ? error.message : 'Failed to pull Web Push notifications.',
            });
        }
    });

    router.post('/webpush/test', async (request, response) => {
        try {
            const owner = getOwnerKey(request);
            const result = await sendWebPushNotifications({
                owner,
                title: normalizeString(request.body?.title) || WEB_PUSH_TITLE,
                body: normalizeString(request.body?.message) || '这是一条网页通知测试消息。',
                currentUrl: normalizeString(request.body?.currentUrl),
                endpoint: normalizeString(request.body?.endpoint),
                tag: `tavern-notify-test-${Date.now()}`,
            });

            return response.json({
                ok: true,
                ...result,
            });
        } catch (error) {
            return response.status(400).json({
                error: true,
                message: error instanceof Error ? error.message : 'Failed to send Web Push test notification.',
            });
        }
    });

    await ensureWebPushState();
    ensureCleanupTimer();
    console.log(`${MODULE_NAME} Plugin loaded.`);
}

export async function exit() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }

    jobs.clear();
    debugOwners.clear();
    webPushSubscriptions.clear();
    webPushPendingNotifications.clear();
    console.log(`${MODULE_NAME} Plugin exited.`);
}

function normalizeCreatePayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Invalid request body.');
    }

    const mainApi = String(body.mainApi || '').trim();
    if (!ENDPOINTS[mainApi]) {
        throw new Error(`Unsupported main API: ${mainApi || '(empty)'}`);
    }

    if (!body.generateData || typeof body.generateData !== 'object' || Array.isArray(body.generateData)) {
        throw new Error('Missing generateData payload.');
    }

    return {
        mainApi,
        generateData: cloneJson(body.generateData),
        bark: sanitizeBarkConfig(body.bark),
        jobMeta: sanitizeJobMeta(body.jobMeta),
        providerContext: sanitizeProviderContext(body.providerContext),
    };
}

function sanitizeBarkConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const bark = {
        serverUrl: normalizeString(value.serverUrl),
        deviceKey: normalizeString(value.deviceKey),
        title: normalizeString(value.title) || normalizeString(value.titlePrefix),
        group: normalizeString(value.group),
        sound: normalizeString(value.sound),
        icon: normalizeString(value.icon),
        level: normalizeString(value.level),
        url: normalizeString(value.url),
        successText: normalizeString(value.successText),
        failureText: normalizeString(value.failureText),
    };

    if (!bark.serverUrl && !bark.deviceKey) {
        return null;
    }

    if (!bark.serverUrl) {
        bark.serverUrl = 'https://api.day.app';
    }

    if (!bark.deviceKey) {
        return null;
    }

    bark.serverUrl = normalizeBarkServerUrl(bark.serverUrl, bark.deviceKey);

    return bark;
}

function normalizeBarkServerUrl(serverUrl, deviceKey) {
    const fallback = 'https://api.day.app';
    const rawValue = normalizeString(serverUrl) || fallback;

    try {
        const parsed = new URL(rawValue);
        let segments = parsed.pathname.split('/').filter(Boolean);

        if (segments.at(-1) === 'push') {
            segments = segments.slice(0, -1);
        }

        const deviceKeyIndex = segments.findIndex(segment => decodeURIComponent(segment) === deviceKey);
        if (deviceKeyIndex >= 0) {
            segments = segments.slice(0, deviceKeyIndex);
        }

        parsed.pathname = segments.length > 0 ? `/${segments.join('/')}` : '/';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return rawValue.replace(/\/+$/, '').replace(/\/push$/, '');
    }
}

function sanitizeJobMeta(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            notificationChannel: 'bark',
            notificationTitle: '',
            webPushEndpoint: '',
        };
    }

    return {
        type: normalizeString(value.type),
        chatId: normalizeString(value.chatId),
        characterName: normalizeString(value.characterName),
        currentUrl: normalizeString(value.currentUrl),
        notificationChannel: normalizeNotificationChannel(value.notificationChannel),
        notificationTitle: normalizeString(value.notificationTitle),
        webPushEndpoint: normalizeString(value.webPushEndpoint),
    };
}

function normalizeNotificationChannel(value) {
    return normalizeString(value) === 'webpush' ? 'webpush' : 'bark';
}

function sanitizeProviderContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return {
        chatCompletionSource: normalizeString(value.chatCompletionSource),
        textGenType: normalizeString(value.textGenType),
        model: normalizeString(value.model),
    };
}

function createJob(request, payload) {
    const now = new Date().toISOString();
    const owner = getOwnerKey(request);

    return {
        id: randomUUID(),
        owner,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        mainApi: payload.mainApi,
        endpoint: ENDPOINTS[payload.mainApi],
        requestBody: prepareRequestBody(payload.generateData),
        bark: payload.bark,
        jobMeta: payload.jobMeta,
        providerContext: payload.providerContext,
        requestContext: {
            baseUrl: getInternalBaseUrl(request),
            headers: getForwardedHeaders(request.headers),
        },
        response: null,
        error: null,
        preview: '',
        debugEnabled: isDebugEnabled(owner),
    };
}

function prepareRequestBody(generateData) {
    const payload = cloneJson(generateData);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        if (Object.hasOwn(payload, 'stream')) {
            payload.stream = false;
        }

        if (Object.hasOwn(payload, 'streaming')) {
            payload.streaming = false;
        }

        if (Object.hasOwn(payload, 'can_abort')) {
            payload.can_abort = false;
        }
    }

    return payload;
}

function getForwardedHeaders(headers) {
    const forwardedHeaders = {
        accept: 'application/json',
        'content-type': 'application/json',
    };

    for (const headerName of FORWARDED_HEADER_NAMES) {
        const value = headers?.[headerName];
        if (typeof value === 'string' && value.length > 0) {
            forwardedHeaders[headerName] = value;
        }
    }

    return forwardedHeaders;
}

function getInternalBaseUrl(request) {
    const localPort = request.socket?.localPort;
    if (localPort) {
        return `http://127.0.0.1:${localPort}`;
    }

    const forwardedProtocol = normalizeString(request.headers?.['x-forwarded-proto'])?.split(',')[0];
    const protocol = forwardedProtocol || request.protocol || 'http';
    const host = request.get?.('host');

    if (!host) {
        throw new Error('Unable to determine local server address.');
    }

    return `${protocol}://${host}`;
}

async function runJob(job) {
    updateJob(job, { status: 'running', error: null });
    jobLog(job, 'Starting background request.');

    try {
        const response = await fetch(`${job.requestContext.baseUrl}${job.endpoint}`, {
            method: 'POST',
            headers: job.requestContext.headers,
            body: JSON.stringify(job.requestBody),
        });

        const payload = await readResponseBody(response);
        if (!response.ok) {
            throw buildRequestError(response, payload);
        }

        if (payload?.error) {
            throw new Error(extractNestedMessage(payload) || 'SillyTavern generation returned an error.');
        }

        updateJob(job, {
            status: 'completed',
            response: payload,
            preview: extractMessagePreview(job.mainApi, payload),
        });
        jobLog(job, 'Background request completed.', {
            preview: job.preview,
        });

        await notifyForJob(job, false);
    } catch (error) {
        updateJob(job, {
            status: 'failed',
            error: serializeError(error),
        });
        jobLog(job, 'Background request failed.', job.error);

        await notifyForJob(job, true);
    }
}

async function notifyForJob(job, failed) {
    if (job.jobMeta.notificationChannel === 'webpush') {
        try {
            await sendWebPushNotifications({
                owner: job.owner,
                title: job.jobMeta.notificationTitle || WEB_PUSH_TITLE,
                body: buildWebPushBody(job.jobMeta, failed),
                currentUrl: job.jobMeta.currentUrl,
                endpoint: job.jobMeta.webPushEndpoint,
                tag: `tavern-notify-${failed ? 'failed' : 'completed'}-${job.id}`,
            });
            jobLog(job, 'Queued Web Push notification.', {
                endpoint: job.jobMeta.webPushEndpoint || '(all subscriptions)',
                failed,
            });
        } catch (notificationError) {
            console.warn(`${MODULE_NAME} Web Push notification failed for job ${job.id}.`, notificationError);
        }
        return;
    }

    try {
        await sendBarkNotification({
            bark: job.bark,
            jobMeta: job.jobMeta,
            failed,
        });
        jobLog(job, 'Sent Bark notification.', { failed });
    } catch (notificationError) {
        console.warn(`${MODULE_NAME} Bark notification failed for job ${job.id}.`, notificationError);
    }
}

function buildWebPushBody(jobMeta, failed, bodyText = '') {
    const body = String(bodyText || (failed ? WEB_PUSH_FAILURE_BODY : WEB_PUSH_SUCCESS_BODY)).trim();
    const characterName = normalizeString(jobMeta?.characterName);
    return characterName ? `${characterName}：${body}` : body;
}

async function ensureWebPushState() {
    if (!webPushStatePromise) {
        webPushStatePromise = loadWebPushState();
    }

    await webPushStatePromise;
    return webPushVapid;
}

async function loadWebPushState() {
    try {
        const raw = await readFile(WEB_PUSH_STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);

        if (parsed?.vapid?.publicKey && parsed?.vapid?.privateKeyPem) {
            webPushVapid = {
                publicKey: normalizeString(parsed.vapid.publicKey),
                privateKeyPem: String(parsed.vapid.privateKeyPem),
            };
        }

        if (!webPushVapid?.publicKey || !webPushVapid?.privateKeyPem) {
            webPushVapid = createVapidKeyPair();
        }

        const subscriptions = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
        for (const entry of subscriptions) {
            const subscription = sanitizeWebPushSubscription(entry, { allowMissingOwner: true });
            webPushSubscriptions.set(subscription.endpoint, {
                endpoint: subscription.endpoint,
                owner: normalizeString(entry.owner) || 'default',
                createdAt: normalizeString(entry.createdAt) || new Date().toISOString(),
                updatedAt: normalizeString(entry.updatedAt) || new Date().toISOString(),
            });
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.warn(`${MODULE_NAME} Failed to load Web Push state, recreating.`, error);
        }

        webPushVapid = createVapidKeyPair();
        await persistWebPushState();
    }
}

function createVapidKeyPair() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
    });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const rawPublicKey = Buffer.concat([
        Buffer.from([0x04]),
        base64UrlToBuffer(publicJwk.x),
        base64UrlToBuffer(publicJwk.y),
    ]);

    return {
        publicKey: bufferToBase64Url(rawPublicKey),
        privateKeyPem: privateKey.export({
            format: 'pem',
            type: 'pkcs8',
        }).toString(),
    };
}

async function persistWebPushState() {
    const payload = {
        vapid: webPushVapid,
        subscriptions: Array.from(webPushSubscriptions.values()),
    };

    try {
        await writeFile(WEB_PUSH_STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
        console.warn(`${MODULE_NAME} Failed to persist Web Push state.`, error);
    }
}

function sanitizeWebPushSubscription(value, { allowMissingOwner = false } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid Web Push subscription payload.');
    }

    const endpoint = normalizeString(value.endpoint);
    if (!endpoint) {
        throw new Error('Missing Web Push endpoint.');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(endpoint);
    } catch {
        throw new Error('Invalid Web Push endpoint.');
    }

    if (parsedUrl.protocol !== 'https:') {
        throw new Error('Web Push endpoint must use HTTPS.');
    }

    const owner = normalizeString(value.owner);
    if (!allowMissingOwner && !owner) {
        return {
            endpoint: parsedUrl.toString(),
        };
    }

    return {
        endpoint: parsedUrl.toString(),
        owner,
    };
}

async function upsertWebPushSubscription(owner, subscription) {
    const now = new Date().toISOString();
    const existing = webPushSubscriptions.get(subscription.endpoint);
    webPushSubscriptions.set(subscription.endpoint, {
        endpoint: subscription.endpoint,
        owner,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    });
    await persistWebPushState();
}

async function removeWebPushSubscription(owner, endpoint) {
    const existing = webPushSubscriptions.get(endpoint);
    if (!existing) {
        return;
    }

    if (existing.owner !== owner) {
        throw new Error('Web Push subscription does not belong to the current user.');
    }

    webPushSubscriptions.delete(endpoint);
    webPushPendingNotifications.delete(endpoint);
    await persistWebPushState();
}

function pullWebPushNotifications(owner, endpoint) {
    const subscription = webPushSubscriptions.get(endpoint);
    if (!subscription) {
        throw new Error('Web Push subscription not found.');
    }

    if (subscription.owner !== owner) {
        throw new Error('Web Push subscription does not belong to the current user.');
    }

    const notifications = webPushPendingNotifications.get(endpoint) || [];
    webPushPendingNotifications.delete(endpoint);
    return notifications;
}

function getWebPushSubscriptionsForOwner(owner) {
    return Array.from(webPushSubscriptions.values())
        .filter(subscription => subscription.owner === owner);
}

function enqueueWebPushNotification(endpoint, notification) {
    const queue = webPushPendingNotifications.get(endpoint) || [];
    queue.push(notification);
    webPushPendingNotifications.set(endpoint, queue.slice(-20));
}

async function sendWebPushNotifications({ owner, title, body, currentUrl, endpoint = '', tag = '' }) {
    await ensureWebPushState();

    const subscriptions = endpoint
        ? getWebPushSubscriptionsForOwner(owner).filter(item => item.endpoint === endpoint)
        : getWebPushSubscriptionsForOwner(owner);

    if (subscriptions.length === 0) {
        debugLog(owner, 'Skipping Web Push notification because no subscriptions matched.', {
            endpoint: endpoint || '(all subscriptions)',
        });
        return {
            subscriptionCount: 0,
            acceptedCount: 0,
        };
    }

    const notification = {
        id: randomUUID(),
        title: title || WEB_PUSH_TITLE,
        body: body || WEB_PUSH_SUCCESS_BODY,
        tag: tag || `tavern-notify-${Date.now()}`,
        data: {
            url: normalizeString(currentUrl),
        },
    };

    for (const subscription of subscriptions) {
        enqueueWebPushNotification(subscription.endpoint, notification);
    }

    let acceptedCount = 0;
    let firstError = null;
    const subject = resolveWebPushSubject(currentUrl);

    for (const subscription of subscriptions) {
        try {
            await sendEmptyWebPush(subscription.endpoint, subject);
            acceptedCount += 1;
        } catch (error) {
            if (isExpiredWebPushSubscription(error)) {
                webPushSubscriptions.delete(subscription.endpoint);
                webPushPendingNotifications.delete(subscription.endpoint);
                await persistWebPushState();
            }

            if (!firstError) {
                firstError = error;
            }

            debugLog(owner, 'Web Push delivery failed.', {
                endpoint: subscription.endpoint,
                message: error instanceof Error ? error.message : String(error),
                status: typeof error?.status === 'number' ? error.status : null,
            });
        }
    }

    if (acceptedCount === 0 && firstError) {
        throw firstError;
    }

    debugLog(owner, 'Dispatched Web Push notification.', {
        subscriptionCount: subscriptions.length,
        acceptedCount,
        title: notification.title,
    });
    return {
        subscriptionCount: subscriptions.length,
        acceptedCount,
    };
}

async function sendEmptyWebPush(endpoint, subject) {
    const vapid = await ensureWebPushState();
    const endpointUrl = new URL(endpoint);
    const jwt = createVapidJwt(endpointUrl.origin, subject, vapid.privateKeyPem);
    const headers = {
        TTL: String(WEB_PUSH_TTL_SECONDS),
        Urgency: 'high',
        'Content-Length': '0',
    };

    if (isGooglePushEndpoint(endpointUrl)) {
        headers.Authorization = `WebPush ${jwt}`;
        headers['Crypto-Key'] = `p256ecdsa=${vapid.publicKey}`;
    } else {
        headers.Authorization = `vapid t=${jwt}, k=${vapid.publicKey}`;
    }

    const response = await fetch(endpointUrl, {
        method: 'POST',
        headers,
    });
    if (!response.ok) {
        const payload = await readResponseBody(response);
        const error = buildRequestError(response, payload);
        error.status = response.status;
        throw error;
    }
}

function createVapidJwt(audience, subject, privateKeyPem) {
    const header = bufferToBase64Url(Buffer.from(JSON.stringify({
        alg: 'ES256',
        typ: 'JWT',
    })));
    const payload = bufferToBase64Url(Buffer.from(JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + (12 * 60 * 60),
        sub: subject || WEB_PUSH_SUBJECT,
    })));
    const unsignedToken = `${header}.${payload}`;
    const signature = createSign('SHA256')
        .update(unsignedToken)
        .end()
        .sign({
            key: createPrivateKey(privateKeyPem),
            dsaEncoding: 'ieee-p1363',
        });

    return `${unsignedToken}.${bufferToBase64Url(signature)}`;
}

function resolveWebPushSubject(currentUrl) {
    const normalizedUrl = normalizeString(currentUrl);
    if (normalizedUrl) {
        try {
            const parsed = new URL(normalizedUrl);
            if (parsed.protocol === 'https:') {
                return parsed.origin;
            }
        } catch {
            return WEB_PUSH_SUBJECT;
        }
    }

    return WEB_PUSH_SUBJECT;
}

function isGooglePushEndpoint(endpointUrl) {
    return /(^|\.)googleapis\.com$/i.test(endpointUrl.hostname)
        || /(^|\.)fcm\.googleapis\.com$/i.test(endpointUrl.hostname);
}

function isExpiredWebPushSubscription(error) {
    return typeof error?.status === 'number' && [404, 410].includes(error.status);
}

async function readResponseBody(response) {
    const contentType = String(response.headers.get('content-type') || '');
    if (contentType.includes('application/json')) {
        return await response.json();
    }

    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return { text };
    }
}

function buildRequestError(response, payload) {
    const message = extractNestedMessage(payload) || response.statusText || `Request failed with status ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    return error;
}

function extractNestedMessage(value) {
    if (!value) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value?.message === 'string') {
        return value.message;
    }

    if (typeof value?.response === 'string') {
        return value.response;
    }

    if (typeof value?.error === 'string') {
        return value.error;
    }

    if (typeof value?.error?.message === 'string') {
        return value.error.message;
    }

    if (typeof value?.detail === 'string') {
        return value.detail;
    }

    if (typeof value?.detail?.error?.message === 'string') {
        return value.detail.error.message;
    }

    return '';
}

function extractMessagePreview(mainApi, payload) {
    const message = extractMessage(mainApi, payload).trim();
    if (!message) {
        return '';
    }

    return message.replace(/\s+/g, ' ').slice(0, 180);
}

function extractMessage(mainApi, payload) {
    if (typeof payload === 'string') {
        return payload;
    }

    switch (mainApi) {
        case 'kobold':
            return payload?.results?.[0]?.text || '';
        case 'koboldhorde':
            return payload?.text || '';
        case 'textgenerationwebui': {
            const result = payload?.choices?.[0]?.text
                ?? payload?.choices?.[0]?.message?.content
                ?? payload?.content
                ?? payload?.response
                ?? payload?.[0]?.content
                ?? '';
            return Array.isArray(result) ? result.map(part => part?.text || '').filter(Boolean).join('') : result;
        }
        case 'novel':
            return payload?.output || '';
        case 'openai': {
            const result = payload?.content?.find?.(part => part?.type === 'text')?.text
                ?? payload?.choices?.[0]?.message?.content
                ?? payload?.choices?.[0]?.text
                ?? payload?.text
                ?? payload?.message?.content?.[0]?.text
                ?? payload?.message?.tool_plan
                ?? '';
            return Array.isArray(result) ? result.map(part => part?.text || '').filter(Boolean).join('') : result;
        }
        default:
            return '';
    }
}

async function sendBarkNotification({ bark, jobMeta, failed, bodyText = '' }) {
    if (!bark?.deviceKey) {
        return;
    }

    const serverUrl = String(bark.serverUrl || 'https://api.day.app')
        .replace(/\/+$/, '')
        .replace(/\/push$/, '');
    const title = bark.title || normalizeString(jobMeta?.notificationTitle) || WEB_PUSH_TITLE;
    const subtitle = normalizeString(jobMeta?.characterName);
    const message = String(
        bodyText
        || (failed
            ? bark.failureText || WEB_PUSH_FAILURE_BODY
            : bark.successText || WEB_PUSH_SUCCESS_BODY),
    ).trim();

    const pathSegments = [
        encodeURIComponent(bark.deviceKey),
        encodeURIComponent(title),
    ];

    if (subtitle) {
        pathSegments.push(encodeURIComponent(subtitle));
    }

    pathSegments.push(encodeURIComponent(message));

    const requestUrl = new URL(`${serverUrl}/${pathSegments.join('/')}`);

    if (bark.group) {
        requestUrl.searchParams.set('group', bark.group);
    }
    if (bark.sound) {
        requestUrl.searchParams.set('sound', bark.sound);
    }
    if (bark.icon) {
        requestUrl.searchParams.set('icon', bark.icon);
    }
    if (bark.level) {
        requestUrl.searchParams.set('level', bark.level);
    }
    if (bark.url || jobMeta?.currentUrl) {
        requestUrl.searchParams.set('url', bark.url || jobMeta.currentUrl);
    }

    const response = await fetch(requestUrl, {
        method: 'GET',
        headers: {
            accept: 'application/json',
        },
    });
    if (!response.ok) {
        const payload = await readResponseBody(response);
        throw buildRequestError(response, payload);
    }
}

function publicJob(job, { includeResult = false } = {}) {
    const payload = {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        mainApi: job.mainApi,
        preview: job.preview,
        error: job.error,
        jobMeta: job.jobMeta,
        providerContext: job.providerContext,
    };

    if (includeResult) {
        payload.response = job.response;
    }

    return payload;
}

function updateJob(job, patch) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function serializeError(error) {
    if (error instanceof Error) {
        return {
            message: error.message,
            status: typeof error.status === 'number' ? error.status : null,
        };
    }

    return {
        message: typeof error === 'string' ? error : 'Unknown error.',
        status: null,
    };
}

function getOwnerKey(request) {
    return (
        normalizeString(request.user?.profile?.handle) ||
        normalizeString(request.user?.profile?.name) ||
        normalizeString(request.user?.directories?.root) ||
        'default'
    );
}

function setDebugMode(owner, enabled) {
    if (enabled) {
        debugOwners.add(owner);
        return;
    }

    debugOwners.delete(owner);
}

function isDebugEnabled(owner) {
    return debugOwners.has(owner);
}

function debugLog(owner, message, extra = null) {
    if (!isDebugEnabled(owner)) {
        return;
    }

    if (extra === null) {
        console.log(`${MODULE_NAME} [debug:${owner}] ${message}`);
        return;
    }

    console.log(`${MODULE_NAME} [debug:${owner}] ${message}`, extra);
}

function jobLog(job, message, extra = null) {
    if (!job?.debugEnabled) {
        return;
    }

    if (extra === null) {
        console.log(`${MODULE_NAME} [job:${job.id}] ${message}`);
        return;
    }

    console.log(`${MODULE_NAME} [job:${job.id}] ${message}`, extra);
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function bufferToBase64Url(value) {
    return Buffer.from(value)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlToBuffer(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return Buffer.from(padded, 'base64');
}

function ensureCleanupTimer() {
    if (cleanupTimer) {
        return;
    }

    cleanupTimer = setInterval(cleanExpiredJobs, CLEANUP_INTERVAL_MS);
    if (typeof cleanupTimer.unref === 'function') {
        cleanupTimer.unref();
    }
}

function cleanExpiredJobs() {
    const now = Date.now();
    for (const [jobId, job] of jobs.entries()) {
        if (['queued', 'running'].includes(job.status)) {
            continue;
        }

        const updatedAt = Date.parse(job.updatedAt || job.createdAt);
        if (Number.isFinite(updatedAt) && now - updatedAt > JOB_TTL_MS) {
            jobs.delete(jobId);
        }
    }
}

export default {
    info,
    init,
    exit,
};
