import {
    eventSource,
    event_types,
    extractMessageFromData,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import {
    extractReasoningFromData,
    extractReasoningSignatureFromData,
} from '../../../reasoning.js';
import {
    createGenerationParameters,
    getChatCompletionModel,
    oai_settings,
} from '../../../openai.js';
import {
    createChatOpenAutoScroller,
    findChatScrollContainer,
    findChatScrollObserveRoot,
    scrollContainerToBottom,
} from './chat-auto-scroll.js';
import { createDeferredStartupScheduler } from './startup-deferred.js';

export const MODULE_NAME = 'tavern-notify';

const EXTENSION_NAME = 'third-party/tavern-notify';
const PLUGIN_ROUTE = '/api/plugins/tavern-notify';
const WEB_PUSH_SW_VERSION = '20260314-1';
const WEB_PUSH_SW_BASENAME = `${PLUGIN_ROUTE}/webpush/sw.js`;
const WEB_PUSH_SW_PATH = `${WEB_PUSH_SW_BASENAME}?v=${WEB_PUSH_SW_VERSION}`;
const CHAT_STATE_KEY = 'tavernNotify';
const POLL_INTERVAL_MS = 5000;
const PLUGIN_PROBE_TTL_MS = 30000;
const REFRESH_MENU_OPTION_ID = 'tavern_notify_option_refresh';
const NOTIFICATION_CHANNELS = {
    bark: 'bark',
    webpush: 'webpush',
};

const DEFAULT_SETTINGS = {
    enabled: false,
    debugEnabled: false,
    notificationChannel: NOTIFICATION_CHANNELS.bark,
    barkServerUrl: 'https://api.day.app',
    barkDeviceKey: '',
    barkIconUrl: '',
    barkGroup: 'SillyTavern',
    barkSound: '',
    barkTitlePrefix: '酒馆后台通知',
    openUrlOnNotification: true,
    standaloneRefreshButton: true,
};

let probeState = {
    checkedAt: 0,
    ok: false,
};
let handoffInProgress = false;
let syncInProgress = false;
let pollTimer = null;
let refreshNavigationInProgress = false;
let chatOpenAutoScroller = null;
let deferredStartupScheduler = null;

function ensureSettings() {
    if (!extension_settings.tavernNotify || typeof extension_settings.tavernNotify !== 'object') {
        extension_settings.tavernNotify = {};
    }

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings.tavernNotify[key] === undefined) {
            extension_settings.tavernNotify[key] = value;
        }
    }

    if (!Object.values(NOTIFICATION_CHANNELS).includes(extension_settings.tavernNotify.notificationChannel)) {
        extension_settings.tavernNotify.notificationChannel = DEFAULT_SETTINGS.notificationChannel;
    }

    return extension_settings.tavernNotify;
}

function logDebug(message, extra = null) {
    if (!ensureSettings().debugEnabled) {
        return;
    }

    if (extra === null) {
        console.log('[Tavern Notify]', message);
        return;
    }

    console.log('[Tavern Notify]', message, extra);
}

function getChatState(createIfMissing = true) {
    const context = getContext();
    if (!context.chatMetadata) {
        return null;
    }

    if (!context.chatMetadata[CHAT_STATE_KEY] && createIfMissing) {
        context.chatMetadata[CHAT_STATE_KEY] = { pendingJobs: [] };
    }

    const state = context.chatMetadata[CHAT_STATE_KEY];
    if (!state) {
        return null;
    }

    if (!Array.isArray(state.pendingJobs)) {
        state.pendingJobs = [];
    }

    return state;
}

function updateStatus(text, ok = null) {
    const status = $('#tavern_notify_status');
    status.text(text);
    status.removeClass('is-ok is-error');

    if (ok === true) {
        status.addClass('is-ok');
    } else if (ok === false) {
        status.addClass('is-error');
    }
}

function updateWebPushStatus(text, ok = null) {
    const status = $('#tavern_notify_webpush_status');
    status.text(text);
    status.removeClass('is-ok is-error');

    if (ok === true) {
        status.addClass('is-ok');
    } else if (ok === false) {
        status.addClass('is-error');
    }
}

function updateNotificationPanelVisibility() {
    const settings = ensureSettings();
    const useWebPush = settings.notificationChannel === NOTIFICATION_CHANNELS.webpush;
    $('#tavern_notify_bark_panel').toggleClass('is-hidden', useWebPush);
    $('#tavern_notify_webpush_panel').toggleClass('is-hidden', !useWebPush);
}

async function probePlugin(force = false) {
    if (!force && Date.now() - probeState.checkedAt < PLUGIN_PROBE_TTL_MS) {
        updateStatus(probeState.ok ? '插件在线' : '插件不可用', probeState.ok);
        return probeState.ok;
    }

    try {
        const response = await fetch(`${PLUGIN_ROUTE}/probe`, {
            method: 'GET',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        probeState = {
            checkedAt: Date.now(),
            ok: response.ok,
        };
    } catch (error) {
        console.warn('[Tavern Notify] 插件探测失败。', error);
        probeState = {
            checkedAt: Date.now(),
            ok: false,
        };
    }

    updateStatus(probeState.ok ? '插件在线' : '插件不可用', probeState.ok);
    logDebug('Plugin probe result updated.', probeState);
    return probeState.ok;
}

async function syncServerDebugMode() {
    try {
        await fetch(`${PLUGIN_ROUTE}/debug-mode`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                enabled: ensureSettings().debugEnabled,
            }),
        });
    } catch (error) {
        if (ensureSettings().debugEnabled) {
            console.warn('[Tavern Notify] 同步服务端调试开关失败。', error);
        }
    }
}

function buildNotificationTitle() {
    const title = ensureSettings().barkTitlePrefix.trim();
    return title || DEFAULT_SETTINGS.barkTitlePrefix;
}

function normalizeOptionalUrl(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return '';
    }

    try {
        return new URL(trimmed, window.location.href).toString();
    } catch {
        return '';
    }
}

function normalizeBarkIconUrl(value) {
    const absoluteUrl = normalizeOptionalUrl(value);
    if (!absoluteUrl) {
        return '';
    }

    try {
        const parsed = new URL(absoluteUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return '';
        }

        return parsed.toString();
    } catch {
        return '';
    }
}

function isBitmapIconPath(pathname) {
    return /\.(?:png|jpe?g|gif|webp|ico|bmp)$/i.test(pathname);
}

function isSvgIconPath(pathname) {
    return /\.svg$/i.test(pathname);
}

function getBarkIconCandidateScore(candidate) {
    const iconUrl = normalizeBarkIconUrl(candidate?.url);
    if (!iconUrl) {
        return Number.NEGATIVE_INFINITY;
    }

    const parsed = new URL(iconUrl);
    const rel = String(candidate?.rel || '').toLowerCase();
    const sizes = String(candidate?.sizes || '').toLowerCase();
    let score = 0;

    if (rel.includes('apple-touch-icon')) {
        score += 40;
    } else if (rel.includes('shortcut icon')) {
        score += 25;
    } else if (rel.includes('icon')) {
        score += 20;
    }

    if (isBitmapIconPath(parsed.pathname)) {
        score += 30;
    }

    if (/favicon/i.test(parsed.pathname)) {
        score += 10;
    }

    if (sizes && sizes !== 'any') {
        const maxSize = [...sizes.matchAll(/(\d+)x(\d+)/g)]
            .reduce((largest, match) => Math.max(largest, Number(match[1]) || 0, Number(match[2]) || 0), 0);
        score += Math.min(maxSize, 256) / 8;
    }

    if (sizes === 'any') {
        score -= 20;
    }

    if (isSvgIconPath(parsed.pathname)) {
        score -= 60;
    }

    return score;
}

function detectCurrentSiteIconUrl() {
    const candidates = [...document.querySelectorAll('link[rel]')]
        .map(link => ({
            url: link.getAttribute('href'),
            rel: link.getAttribute('rel') || '',
            sizes: link.getAttribute('sizes') || '',
        }))
        .filter(candidate => /\bicon\b/i.test(candidate.rel) || /apple-touch-icon/i.test(candidate.rel));

    try {
        candidates.push({
            url: new URL('/favicon.ico', window.location.origin).toString(),
            rel: 'default-favicon',
            sizes: '',
        });
    } catch {
        // noop
    }

    const uniqueCandidates = new Map();
    for (const candidate of candidates) {
        const iconUrl = normalizeBarkIconUrl(candidate.url);
        if (!iconUrl) {
            continue;
        }

        const score = getBarkIconCandidateScore({
            url: iconUrl,
            rel: candidate.rel,
            sizes: candidate.sizes,
        });
        const current = uniqueCandidates.get(iconUrl);
        if (!current || score > current.score) {
            uniqueCandidates.set(iconUrl, {
                url: iconUrl,
                score,
            });
        }
    }

    return [...uniqueCandidates.values()]
        .sort((left, right) => right.score - left.score)
        .at(0)?.url || '';
}

function buildBarkIconUrl() {
    const settings = ensureSettings();
    return normalizeBarkIconUrl(settings.barkIconUrl) || detectCurrentSiteIconUrl();
}

function buildBarkConfig() {
    const settings = ensureSettings();
    if (!settings.barkDeviceKey.trim()) {
        return null;
    }

    return {
        serverUrl: settings.barkServerUrl.trim(),
        deviceKey: settings.barkDeviceKey.trim(),
        title: buildNotificationTitle(),
        icon: buildBarkIconUrl(),
        group: settings.barkGroup.trim(),
        sound: settings.barkSound.trim(),
        url: settings.openUrlOnNotification ? window.location.href : '',
    };
}

function isWebPushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function isIosLikeBrowser() {
    const userAgent = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const maxTouchPoints = Number(navigator.maxTouchPoints || 0);

    if (/iPhone|iPad|iPod/i.test(userAgent)) {
        return true;
    }

    // iPadOS 桌面版 UA 往往会伪装成 Macintosh，但仍然保留触控点信息。
    return /Mac/i.test(platform) && maxTouchPoints > 1;
}

function isStandaloneMode() {
    return [
        '(display-mode: standalone)',
        '(display-mode: fullscreen)',
        '(display-mode: minimal-ui)',
    ].some(query => window.matchMedia?.(query)?.matches)
        || window.navigator.standalone === true;
}

function shouldShowStandaloneRefreshButton() {
    return ensureSettings().standaloneRefreshButton;
}

function getWebPushEnvironmentIssue() {
    if (!window.isSecureContext) {
        return '网页通知需要 HTTPS 安全上下文。';
    }

    if (isIosLikeBrowser() && !isStandaloneMode()) {
        return 'iPhone / iPad 需要先加入主屏幕，再从图标打开酒馆。';
    }

    return '';
}

function base64UrlToUint8Array(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(normalized + padding);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
}

function uint8ArrayEquals(left, right) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) {
        return false;
    }

    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
}

function buildRefreshUrl() {
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('tavernNotifyRefresh', String(Date.now()));
        return url.toString();
    } catch {
        return window.location.href;
    }
}

function refreshCurrentPage() {
    if (refreshNavigationInProgress) {
        return;
    }

    refreshNavigationInProgress = true;
    const refreshUrl = buildRefreshUrl();
    const currentUrl = window.location.href;
    logDebug('Refreshing current page.', {
        standalone: isStandaloneMode(),
        currentUrl,
        refreshUrl,
    });

    const forceReload = () => {
        try {
            window.location.href = refreshUrl;
        } catch {
            window.location.replace(refreshUrl);
        }
    };

    const fallbackTimeout = window.setTimeout(() => {
        if (window.location.href === currentUrl) {
            forceReload();
        }
    }, 400);

    try {
        const link = document.createElement('a');
        link.href = refreshUrl;
        link.target = '_self';
        link.rel = 'noreferrer';
        link.style.display = 'none';
        document.body.append(link);
        link.click();
        window.setTimeout(() => {
            link.remove();
        }, 0);
    } catch {
        forceReload();
    }

    window.setTimeout(() => {
        if (window.location.href === currentUrl) {
            window.clearTimeout(fallbackTimeout);
            forceReload();
        }
    }, 900);

    window.setTimeout(() => {
        if (window.location.href === currentUrl) {
            refreshNavigationInProgress = false;
        }
    }, 1600);
}

function updateRefreshMenuOption() {
    const existingOption = document.getElementById(REFRESH_MENU_OPTION_ID);
    if (!shouldShowStandaloneRefreshButton()) {
        existingOption?.remove();
        return;
    }

    const regenerateOption = document.getElementById('option_regenerate');
    if (!regenerateOption?.parentElement) {
        return;
    }

    if (existingOption) {
        if (existingOption.previousElementSibling !== regenerateOption) {
            regenerateOption.insertAdjacentElement('afterend', existingOption);
        }
        return;
    }

    const option = document.createElement('a');
    option.id = REFRESH_MENU_OPTION_ID;
    option.innerHTML = `
        <i class="fa-lg fa-solid fa-rotate-right"></i>
        <span>刷新页面</span>
    `;

    const onPressRefresh = event => {
        event.preventDefault();
        event.stopPropagation();
        refreshCurrentPage();
    };

    option.addEventListener('click', onPressRefresh);
    option.addEventListener('touchend', onPressRefresh, { passive: false });

    regenerateOption.insertAdjacentElement('afterend', option);
}

function ensureChatOpenAutoScroller() {
    if (chatOpenAutoScroller) {
        return chatOpenAutoScroller;
    }

    chatOpenAutoScroller = createChatOpenAutoScroller({
        // 聊天容器识别集中交给辅助模块，避免宿主 DOM 变化时散落多处修改。
        findContainer() {
            return findChatScrollContainer(document);
        },
        findObserveRoot() {
            return findChatScrollObserveRoot(document) || document.body;
        },
        scrollToBottom: scrollContainerToBottom,
        root: document.body,
        MutationObserverCtor: globalThis.MutationObserver,
        log(message, extra) {
            logDebug(message, extra);
        },
    });

    return chatOpenAutoScroller;
}

function onChatChanged() {
    const context = getContext();
    if (!context.chatId && !context.groupId) {
        return;
    }

    ensureChatOpenAutoScroller().start();
    void syncPendingJobs();
}

async function runDeferredStartupTasks() {
    await probePlugin(true);
    await syncServerDebugMode();

    if (ensureSettings().notificationChannel === NOTIFICATION_CHANNELS.webpush) {
        await refreshWebPushStatus();

        try {
            await subscribeWebPush({ interactive: false });
        } catch (error) {
            logDebug('Initial web push sync skipped.', {
                message: error instanceof Error ? error.message : String(error),
            });
        }
    } else {
        updateWebPushStatus('未启用', null);
    }

    await syncPendingJobs();
}

function ensureDeferredStartupScheduler() {
    if (deferredStartupScheduler) {
        return deferredStartupScheduler;
    }

    deferredStartupScheduler = createDeferredStartupScheduler({
        // 首屏优先让聊天界面完成挂载，网络与推送同步放到空闲阶段处理。
        runTasks: runDeferredStartupTasks,
    });

    return deferredStartupScheduler;
}

function getSubscriptionServerKey(subscription) {
    const key = subscription?.options?.applicationServerKey;
    if (!key) {
        return null;
    }

    try {
        return new Uint8Array(key);
    } catch {
        return null;
    }
}

async function fetchWebPushConfig() {
    const response = await fetch(`${PLUGIN_ROUTE}/webpush/config`, {
        method: 'GET',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || '读取网页通知配置失败。');
    }

    return await response.json();
}

async function getWebPushRegistration() {
    await unregisterStaleWebPushWorkers();
    const registration = await navigator.serviceWorker.register(WEB_PUSH_SW_PATH, {
        scope: '/',
        updateViaCache: 'none',
    });
    await registration.update().catch(error => {
        logDebug('Failed to update web push service worker.', {
            message: error instanceof Error ? error.message : String(error),
        });
    });
    logDebug('Web push service worker registration ready.', {
        activeScriptUrl: registration.active?.scriptURL || '',
        waitingScriptUrl: registration.waiting?.scriptURL || '',
        installingScriptUrl: registration.installing?.scriptURL || '',
    });
    return await navigator.serviceWorker.ready;
}

async function unregisterStaleWebPushWorkers() {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
        const scriptUrl = registration.active?.scriptURL
            || registration.waiting?.scriptURL
            || registration.installing?.scriptURL
            || '';

        if (!scriptUrl.includes(WEB_PUSH_SW_BASENAME)) {
            continue;
        }

        if (scriptUrl.includes(`v=${WEB_PUSH_SW_VERSION}`)) {
            continue;
        }

        logDebug('Unregistering stale web push service worker.', { scriptUrl });
        await registration.unregister();
    }
}

async function getWebPushSubscription() {
    const registration = await getWebPushRegistration();
    return await registration.pushManager.getSubscription();
}

async function saveWebPushSubscription(subscription) {
    const response = await fetch(`${PLUGIN_ROUTE}/webpush/subscribe`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            subscription: subscription?.toJSON ? subscription.toJSON() : subscription,
        }),
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || '保存网页通知订阅失败。');
    }
}

async function removeWebPushSubscription(endpoint) {
    await fetch(`${PLUGIN_ROUTE}/webpush/unsubscribe`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            endpoint,
        }),
    }).catch(error => {
        logDebug('Failed to remove web push subscription from server.', {
            endpoint,
            message: error instanceof Error ? error.message : String(error),
        });
    });
}

async function refreshWebPushStatus() {
    const settings = ensureSettings();

    if (!isWebPushSupported()) {
        updateWebPushStatus('当前浏览器不支持', false);
        return null;
    }

    const environmentIssue = getWebPushEnvironmentIssue();
    if (environmentIssue) {
        updateWebPushStatus(environmentIssue, false);
        return null;
    }

    if (settings.notificationChannel !== NOTIFICATION_CHANNELS.webpush) {
        updateWebPushStatus('未启用', null);
        return null;
    }

    if (!await probePlugin()) {
        updateWebPushStatus('服务端插件不可用', false);
        return null;
    }

    if (Notification.permission === 'denied') {
        updateWebPushStatus('通知权限已拒绝', false);
        return null;
    }

    try {
        const config = await fetchWebPushConfig();
        const registration = await getWebPushRegistration();
        const subscription = await registration.pushManager.getSubscription();

        if (!subscription) {
            updateWebPushStatus(Notification.permission === 'granted' ? '待订阅' : '等待授权', null);
            return null;
        }

        const expectedKey = base64UrlToUint8Array(config.publicKey);
        const currentKey = getSubscriptionServerKey(subscription);
        if (currentKey && !uint8ArrayEquals(currentKey, expectedKey)) {
            updateWebPushStatus('检测到推送密钥变化，请重新订阅', false);
            return subscription;
        }

        updateWebPushStatus('已订阅', true);
        return subscription;
    } catch (error) {
        console.warn('[Tavern Notify] 初始化网页通知状态失败。', error);
        updateWebPushStatus('初始化失败', false);
        return null;
    }
}

async function subscribeWebPush({ interactive = false } = {}) {
    if (!isWebPushSupported()) {
        throw new Error('当前浏览器不支持网页通知。');
    }

    const environmentIssue = getWebPushEnvironmentIssue();
    if (environmentIssue) {
        throw new Error(environmentIssue);
    }

    if (!await probePlugin()) {
        throw new Error('服务端插件不可用，无法启用网页通知。');
    }

    if (Notification.permission !== 'granted') {
        if (!interactive) {
            updateWebPushStatus('等待授权', null);
            return null;
        }

        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            updateWebPushStatus(permission === 'denied' ? '通知权限已拒绝' : '等待授权', permission === 'denied' ? false : null);
            return null;
        }
    }

    const config = await fetchWebPushConfig();
    const expectedKey = base64UrlToUint8Array(config.publicKey);
    const registration = await getWebPushRegistration();
    let subscription = await registration.pushManager.getSubscription();
    const currentKey = getSubscriptionServerKey(subscription);

    if (subscription && currentKey && !uint8ArrayEquals(currentKey, expectedKey)) {
        await removeWebPushSubscription(subscription.endpoint);
        await subscription.unsubscribe().catch(error => {
            logDebug('Failed to locally drop stale web push subscription.', {
                endpoint: subscription?.endpoint || '',
                message: error instanceof Error ? error.message : String(error),
            });
        });
        subscription = null;
    }

    if (!subscription) {
        subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: expectedKey,
        });
    }

    await saveWebPushSubscription(subscription);
    updateWebPushStatus('已订阅', true);
    logDebug('Web push subscription synced.', {
        endpoint: subscription.endpoint,
    });
    return subscription;
}

async function unsubscribeWebPush() {
    if (!isWebPushSupported()) {
        updateWebPushStatus('当前浏览器不支持', false);
        return;
    }

    const subscription = await getWebPushSubscription();
    if (!subscription) {
        updateWebPushStatus('未订阅', null);
        return;
    }

    await removeWebPushSubscription(subscription.endpoint);
    await subscription.unsubscribe();
    updateWebPushStatus('未订阅', null);
    logDebug('Web push subscription removed.', {
        endpoint: subscription.endpoint,
    });
}

async function getCurrentWebPushEndpoint() {
    try {
        const subscription = await getWebPushSubscription();
        return subscription?.endpoint || '';
    } catch (error) {
        logDebug('Failed to read current web push endpoint.', {
            message: error instanceof Error ? error.message : String(error),
        });
        return '';
    }
}

async function buildNotificationRequest() {
    syncSettingsFromUi();
    const settings = ensureSettings();
    const title = buildNotificationTitle();

    if (settings.notificationChannel === NOTIFICATION_CHANNELS.webpush) {
        let subscription = null;

        try {
            subscription = await subscribeWebPush({ interactive: false });
        } catch (error) {
            logDebug('Web push preflight failed before handoff.', {
                message: error instanceof Error ? error.message : String(error),
            });
        }

        const endpoint = subscription?.endpoint || await getCurrentWebPushEndpoint();
        return {
            bark: null,
            jobMetaPatch: {
                notificationChannel: NOTIFICATION_CHANNELS.webpush,
                notificationTitle: title,
                webPushEndpoint: endpoint,
            },
            hint: endpoint
                ? '生成完成后会通过网页通知提醒你。'
                : '当前尚未完成网页通知订阅，稍后回到页面时会自动同步结果。',
        };
    }

    const bark = buildBarkConfig();
    return {
        bark,
        jobMetaPatch: {
            notificationChannel: NOTIFICATION_CHANNELS.bark,
            notificationTitle: title,
            webPushEndpoint: '',
        },
        hint: bark
            ? '生成完成后会通过 Bark 通知你。'
            : '当前未配置 Bark，稍后回到页面时会自动同步结果。',
    };
}

async function prepareBackgroundGenerateData(mainApi, type, generateData) {
    if (mainApi !== 'openai') {
        return generateData;
    }

    const messages = Array.isArray(generateData?.prompt) ? generateData.prompt : null;
    if (!messages) {
        throw new Error('OpenAI 后台生成缺少消息列表，无法组装请求。');
    }

    const model = getChatCompletionModel(oai_settings);
    const { generate_data } = await createGenerationParameters(oai_settings, model, type, messages);
    return generate_data;
}

function buildProviderContext(mainApi, sourceGenerateData, requestGenerateData) {
    if (mainApi === 'openai') {
        return {
            chatCompletionSource: oai_settings.chat_completion_source || '',
            textGenType: '',
            model: getChatCompletionModel(oai_settings) || '',
        };
    }

    return {
        chatCompletionSource: sourceGenerateData.chat_completion_source || '',
        textGenType: sourceGenerateData.api_type || requestGenerateData.api_type || '',
        model: sourceGenerateData.model || requestGenerateData.model || '',
    };
}

async function captureGenerateData(type) {
    const context = getContext();

    return await new Promise(async (resolve, reject) => {
        let finished = false;
        const timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error('准备后台生成请求时超时。'));
        }, 15000);

        const cleanup = () => {
            if (finished) {
                return;
            }

            finished = true;
            clearTimeout(timeoutId);
            eventSource.removeListener(event_types.GENERATE_AFTER_DATA, onGenerateData);
        };

        const onGenerateData = (generateData, dryRun) => {
            if (!dryRun) {
                return;
            }

            cleanup();
            resolve(JSON.parse(JSON.stringify(generateData)));
        };

        eventSource.on(event_types.GENERATE_AFTER_DATA, onGenerateData);

        try {
            await context.generate(type, {}, true);
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

async function savePendingJob(job) {
    const context = getContext();
    const state = getChatState(true);
    if (!state) {
        return;
    }

    const exists = state.pendingJobs.some(item => item.id === job.id);
    if (!exists) {
        state.pendingJobs.push({
            id: job.id,
            createdAt: job.createdAt,
            mainApi: job.mainApi,
        });
        await context.saveMetadata();
    }
}

async function acknowledgeJob(jobId) {
    try {
        await fetch(`${PLUGIN_ROUTE}/jobs/${encodeURIComponent(jobId)}/ack`, {
            method: 'POST',
            headers: getRequestHeaders(),
        });
    } catch (error) {
        console.warn('[Tavern Notify] Failed to acknowledge job.', error);
    }
}

async function fetchJob(jobId) {
    const response = await fetch(`${PLUGIN_ROUTE}/jobs/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        throw new Error(`读取后台任务 ${jobId} 失败。`);
    }

    return await response.json();
}

async function applyCompletedJob(job) {
    const context = getContext();
    const responseData = job.response;
    const message = String(extractMessageFromData(responseData, job.mainApi) || '');
    const reasoning = extractReasoningFromData(responseData, {
        mainApi: job.mainApi,
        chatCompletionSource: job.providerContext?.chatCompletionSource || null,
        textGenType: job.providerContext?.textGenType || null,
    });
    const reasoningSignature = extractReasoningSignatureFromData(responseData, {
        mainApi: job.mainApi,
        chatCompletionSource: job.providerContext?.chatCompletionSource || null,
    });

    await context.saveReply({
        type: 'normal',
        getMessage: message,
        reasoning,
        reasoningSignature,
    });
    await context.saveChat();
}

async function syncPendingJobs() {
    if (syncInProgress) {
        return;
    }

    const context = getContext();
    if (!context.chatId || context.groupId) {
        return;
    }

    const state = getChatState(false);
    if (!state?.pendingJobs?.length) {
        return;
    }

    syncInProgress = true;

    try {
        const remainingJobs = [];
        logDebug('Syncing pending jobs.', {
            count: state.pendingJobs.length,
        });

        for (const pendingJob of state.pendingJobs) {
            try {
                const job = await fetchJob(pendingJob.id);
                if (!job) {
                    continue;
                }

                if (job.status === 'completed') {
                    await applyCompletedJob(job);
                    await acknowledgeJob(job.id);
                    toastr.success('后台回复已同步回当前聊天。', '酒馆后台通知');
                    logDebug('Pending job completed and synced.', {
                        jobId: job.id,
                    });
                    continue;
                }

                if (job.status === 'failed') {
                    const message = job.error?.message || '后台生成失败。';
                    toastr.error(message, '酒馆后台通知');
                    await acknowledgeJob(job.id);
                    logDebug('Pending job failed.', {
                        jobId: job.id,
                        message,
                    });
                    continue;
                }

                remainingJobs.push(pendingJob);
            } catch (error) {
                console.warn('[Tavern Notify] 同步后台任务失败。', error);
                remainingJobs.push(pendingJob);
            }
        }

        state.pendingJobs = remainingJobs;
        await context.saveMetadata();
    } finally {
        syncInProgress = false;
    }
}

async function handoffToBackground(type, abort) {
    const context = getContext();
    if (!await probePlugin()) {
        return;
    }

    if (ensureSettings().debugEnabled) {
        await syncServerDebugMode();
    }

    const capturedGenerateData = await captureGenerateData(type);
    const requestGenerateData = await prepareBackgroundGenerateData(context.mainApi, type, capturedGenerateData);
    const notificationRequest = await buildNotificationRequest();
    const response = await fetch(`${PLUGIN_ROUTE}/jobs`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            mainApi: context.mainApi,
            generateData: requestGenerateData,
            jobMeta: {
                type,
                chatId: context.chatId,
                characterName: context.name2,
                currentUrl: window.location.href,
                ...notificationRequest.jobMetaPatch,
            },
            providerContext: buildProviderContext(context.mainApi, capturedGenerateData, requestGenerateData),
            bark: notificationRequest.bark,
        }),
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || '启动后台生成失败。');
    }

    const job = await response.json();
    await savePendingJob(job);
    abort(true);

    logDebug('Background job handed off.', {
        jobId: job.id,
        type,
        notificationChannel: notificationRequest.jobMetaPatch.notificationChannel,
    });
    toastr.success(`后台生成已启动。${notificationRequest.hint}`, '酒馆后台通知');
}

async function backgroundGenerateInterceptor(_chat, _contextSize, abort, type) {
    const settings = ensureSettings();
    const context = getContext();

    if (!settings.enabled) {
        return;
    }

    if (handoffInProgress) {
        return;
    }

    if (!['normal', 'regenerate'].includes(type)) {
        return;
    }

    if (!context.chatId || context.groupId) {
        return;
    }

    handoffInProgress = true;

    try {
        await handoffToBackground(type, abort);
    } catch (error) {
        console.warn('[Tavern Notify] 后台接管失败，回退到 SillyTavern 默认生成。', error);
    } finally {
        handoffInProgress = false;
    }
}

function onSettingInput() {
    const settings = ensureSettings();
    settings.enabled = $('#tavern_notify_enabled').prop('checked');
    settings.debugEnabled = $('#tavern_notify_debug_enabled').prop('checked');
    settings.notificationChannel = String($('input[name="tavern_notify_channel"]:checked').val() || DEFAULT_SETTINGS.notificationChannel);
    settings.barkServerUrl = String($('#tavern_notify_bark_server').val() || DEFAULT_SETTINGS.barkServerUrl);
    settings.barkDeviceKey = String($('#tavern_notify_bark_device').val() || '');
    settings.barkIconUrl = String($('#tavern_notify_bark_icon').val() || '');
    settings.barkGroup = String($('#tavern_notify_bark_group').val() || '');
    settings.barkSound = String($('#tavern_notify_bark_sound').val() || '');
    settings.barkTitlePrefix = String($('#tavern_notify_title_prefix').val() || '');
    settings.openUrlOnNotification = $('#tavern_notify_open_url').prop('checked');
    settings.standaloneRefreshButton = $('#tavern_notify_standalone_refresh_button').prop('checked');
    updateRefreshMenuOption();
    saveSettingsDebounced();
}

function syncSettingsFromUi() {
    if (!$('#tavern_notify_enabled').length) {
        return false;
    }

    onSettingInput();
    return true;
}

function loadSettingsIntoUi() {
    const settings = ensureSettings();
    $('#tavern_notify_enabled').prop('checked', settings.enabled);
    $('#tavern_notify_debug_enabled').prop('checked', settings.debugEnabled);
    $(`input[name="tavern_notify_channel"][value="${settings.notificationChannel}"]`).prop('checked', true);
    $('#tavern_notify_bark_server').val(settings.barkServerUrl);
    $('#tavern_notify_bark_device').val(settings.barkDeviceKey);
    $('#tavern_notify_bark_icon').val(settings.barkIconUrl);
    $('#tavern_notify_bark_group').val(settings.barkGroup);
    $('#tavern_notify_bark_sound').val(settings.barkSound);
    $('#tavern_notify_title_prefix').val(settings.barkTitlePrefix);
    $('#tavern_notify_open_url').prop('checked', settings.openUrlOnNotification);
    $('#tavern_notify_standalone_refresh_button').prop('checked', settings.standaloneRefreshButton);
    updateNotificationPanelVisibility();
    updateRefreshMenuOption();
}

async function sendBarkTestNotification() {
    syncSettingsFromUi();
    const bark = buildBarkConfig();
    if (!bark) {
        toastr.error('请先填写 Bark Device Key。', '酒馆后台通知');
        return;
    }

    const response = await fetch(`${PLUGIN_ROUTE}/notify-test`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            bark,
            message: '酒馆后台通知测试推送',
            jobMeta: {
                characterName: getContext().name2,
                currentUrl: window.location.href,
                notificationTitle: buildNotificationTitle(),
            },
        }),
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || '发送 Bark 测试通知失败。');
    }

    toastr.success('测试通知已发送到 Bark。', '酒馆后台通知');
}

async function sendWebPushTestNotification() {
    const subscription = await subscribeWebPush({ interactive: true });
    if (!subscription?.endpoint) {
        throw new Error('当前浏览器尚未完成网页通知订阅。');
    }

    const response = await fetch(`${PLUGIN_ROUTE}/webpush/test`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            endpoint: subscription.endpoint,
            currentUrl: window.location.href,
            title: buildNotificationTitle(),
            message: '酒馆后台通知网页推送测试',
        }),
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || '发送网页通知测试失败。');
    }

    toastr.success('测试网页通知已发送。', '酒馆后台通知');
}

async function sendLocalWebPushTestNotification() {
    if (!isWebPushSupported()) {
        throw new Error('当前浏览器不支持网页通知。');
    }

    const environmentIssue = getWebPushEnvironmentIssue();
    if (environmentIssue) {
        throw new Error(environmentIssue);
    }

    if (Notification.permission !== 'granted') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            throw new Error('浏览器通知权限未授予。');
        }
    }

    const registration = await getWebPushRegistration();
    await registration.showNotification(buildNotificationTitle(), {
        body: '这是一条本地通知测试消息。',
        tag: `tavern-notify-local-${Date.now()}`,
        data: {
            url: window.location.href,
        },
    });
    logDebug('Local web notification test shown.');
}

async function onDebugToggle() {
    onSettingInput();
    await syncServerDebugMode();
    if (ensureSettings().debugEnabled) {
        logDebug('Debug mode enabled.');
    }
}

async function onNotificationChannelChange() {
    onSettingInput();
    updateNotificationPanelVisibility();

    if (ensureSettings().notificationChannel === NOTIFICATION_CHANNELS.webpush) {
        await refreshWebPushStatus();
        try {
            await subscribeWebPush({ interactive: false });
        } catch (error) {
            logDebug('Automatic web push sync skipped after channel change.', {
                message: error instanceof Error ? error.message : String(error),
            });
        }
        return;
    }

    updateWebPushStatus('未启用', null);
}

function bindUi() {
    $('#tavern_notify_enabled').off('change').on('change', onSettingInput);
    $('#tavern_notify_debug_enabled').off('change').on('change', () => {
        void onDebugToggle();
    });
    $('input[name="tavern_notify_channel"]').off('change').on('change', () => {
        void onNotificationChannelChange();
    });
    $('#tavern_notify_bark_server').off('input change').on('input change', onSettingInput);
    $('#tavern_notify_bark_device').off('input change').on('input change', onSettingInput);
    $('#tavern_notify_bark_icon').off('input change').on('input change', onSettingInput);
    $('#tavern_notify_bark_group').off('input change').on('input change', onSettingInput);
    $('#tavern_notify_bark_sound').off('input change').on('input change', onSettingInput);
    $('#tavern_notify_title_prefix').off('input change').on('input change', onSettingInput);
    $('#tavern_notify_open_url').off('change').on('change', onSettingInput);
    $('#tavern_notify_standalone_refresh_button').off('change').on('change', onSettingInput);

    $('#tavern_notify_probe').off('click').on('click', async () => {
        const ok = await probePlugin(true);
        toastr[ok ? 'success' : 'error'](
            ok ? '服务端插件可访问。' : '服务端插件不可访问。',
            '酒馆后台通知',
        );

        if (ensureSettings().notificationChannel === NOTIFICATION_CHANNELS.webpush) {
            await refreshWebPushStatus();
        }
    });

    $('#tavern_notify_test').off('click').on('click', async () => {
        try {
            await sendBarkTestNotification();
        } catch (error) {
            toastr.error(error instanceof Error ? error.message : '发送测试通知失败。', '酒馆后台通知');
        }
    });

    $('#tavern_notify_webpush_subscribe').off('click').on('click', async () => {
        try {
            const subscription = await subscribeWebPush({ interactive: true });
            if (subscription) {
                toastr.success('网页通知订阅成功。', '酒馆后台通知');
            }
        } catch (error) {
            toastr.error(error instanceof Error ? error.message : '订阅网页通知失败。', '酒馆后台通知');
        }
    });

    $('#tavern_notify_webpush_unsubscribe').off('click').on('click', async () => {
        try {
            await unsubscribeWebPush();
            toastr.success('网页通知订阅已取消。', '酒馆后台通知');
        } catch (error) {
            toastr.error(error instanceof Error ? error.message : '取消网页通知失败。', '酒馆后台通知');
        }
    });

    $('#tavern_notify_webpush_test').off('click').on('click', async () => {
        try {
            await sendWebPushTestNotification();
        } catch (error) {
            toastr.error(error instanceof Error ? error.message : '发送网页通知测试失败。', '酒馆后台通知');
        }
    });

    $('#tavern_notify_webpush_local_test').off('click').on('click', async () => {
        try {
            await sendLocalWebPushTestNotification();
            toastr.success('本地通知测试已发送。', '酒馆后台通知');
        } catch (error) {
            toastr.error(error instanceof Error ? error.message : '发送本地通知测试失败。', '酒馆后台通知');
        }
    });
}

async function mountSettings() {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    $('#extensions_settings2').append(html);
    loadSettingsIntoUi();
    bindUi();
}

function startPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
    }

    pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') {
            updateRefreshMenuOption();
            void syncPendingJobs();
        }
    }, POLL_INTERVAL_MS);
}

async function init() {
    ensureSettings();
    await mountSettings();
    updateRefreshMenuOption();
    ensureChatOpenAutoScroller();

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            updateRefreshMenuOption();
            void syncPendingJobs();

            if (ensureSettings().notificationChannel === NOTIFICATION_CHANNELS.webpush) {
                void refreshWebPushStatus();
            }
        }
    });
    window.addEventListener('pageshow', () => {
        updateRefreshMenuOption();
    });

    startPolling();

    if (ensureSettings().notificationChannel === NOTIFICATION_CHANNELS.webpush) {
        updateWebPushStatus('初始化中', null);
    } else {
        updateWebPushStatus('未启用', null);
    }

    ensureDeferredStartupScheduler().schedule();
}

globalThis.TAVERN_NOTIFY_INTERCEPT = backgroundGenerateInterceptor;

jQuery(() => {
    void init();
});
