import { randomUUID } from 'node:crypto';

const MODULE_NAME = '[TavernNotify]';
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const FORWARDED_HEADER_NAMES = ['authorization', 'cookie', 'user-agent', 'x-csrf-token'];

const ENDPOINTS = {
    openai: '/api/backends/chat-completions/generate',
    textgenerationwebui: '/api/backends/text-completions/generate',
    kobold: '/api/backends/kobold/generate',
    koboldhorde: '/api/backends/koboldhorde/generate',
    novel: '/api/novelai/generate',
};

const jobs = new Map();
let cleanupTimer = null;

export const info = {
    id: 'tavern-notify',
    name: 'Tavern Notify',
    description: 'Runs compatible SillyTavern generations in the background and pushes Bark notifications on completion.',
};

export async function init(router) {
    router.get('/probe', (_request, response) => {
        return response.sendStatus(204);
    });

    router.post('/jobs', async (request, response) => {
        try {
            const payload = normalizeCreatePayload(request.body);
            const job = createJob(request, payload);
            jobs.set(job.id, job);
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

    ensureCleanupTimer();
    console.log(`${MODULE_NAME} Plugin loaded.`);
}

export async function exit() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }

    jobs.clear();
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
        return {};
    }

    return {
        type: normalizeString(value.type),
        chatId: normalizeString(value.chatId),
        characterName: normalizeString(value.characterName),
        currentUrl: normalizeString(value.currentUrl),
    };
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

    return {
        id: randomUUID(),
        owner: getOwnerKey(request),
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

        try {
            await sendBarkNotification({
                bark: job.bark,
                jobMeta: job.jobMeta,
                failed: false,
            });
        } catch (error) {
            console.warn(`${MODULE_NAME} Bark notification failed for completed job ${job.id}.`, error);
        }
    } catch (error) {
        updateJob(job, {
            status: 'failed',
            error: serializeError(error),
        });

        try {
            await sendBarkNotification({
                bark: job.bark,
                jobMeta: job.jobMeta,
                failed: true,
            });
        } catch (notificationError) {
            console.warn(`${MODULE_NAME} Bark notification failed for failed job ${job.id}.`, notificationError);
        }
    }
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
    const title = bark.title || '酒馆后台通知';
    const subtitle = normalizeString(jobMeta?.characterName);
    const message = String(
        bodyText
        || (failed
            ? bark.failureText || '后台生成失败，请回到酒馆查看。'
            : bark.successText || '回复已生成，请回到酒馆查看。'),
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

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
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
