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

export const MODULE_NAME = 'tavern-notify';

const EXTENSION_NAME = 'third-party/tavern-notify';
const PLUGIN_ROUTE = '/api/plugins/tavern-notify';
const CHAT_STATE_KEY = 'tavernNotify';
const POLL_INTERVAL_MS = 5000;
const PLUGIN_PROBE_TTL_MS = 30000;

const DEFAULT_SETTINGS = {
    enabled: false,
    barkServerUrl: 'https://api.day.app',
    barkDeviceKey: '',
    barkGroup: 'SillyTavern',
    barkSound: '',
    barkTitlePrefix: '酒馆后台通知',
    openUrlOnNotification: true,
};

let probeState = {
    checkedAt: 0,
    ok: false,
};
let handoffInProgress = false;
let syncInProgress = false;
let pollTimer = null;

function ensureSettings() {
    if (!extension_settings.tavernNotify || typeof extension_settings.tavernNotify !== 'object') {
        extension_settings.tavernNotify = {};
    }

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings.tavernNotify[key] === undefined) {
            extension_settings.tavernNotify[key] = value;
        }
    }

    return extension_settings.tavernNotify;
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
    return probeState.ok;
}

function buildBarkConfig() {
    const settings = ensureSettings();
    if (!settings.barkDeviceKey.trim()) {
        return null;
    }

    return {
        serverUrl: settings.barkServerUrl.trim(),
        deviceKey: settings.barkDeviceKey.trim(),
        title: settings.barkTitlePrefix.trim(),
        group: settings.barkGroup.trim(),
        sound: settings.barkSound.trim(),
        url: settings.openUrlOnNotification ? window.location.href : '',
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
                    continue;
                }

                if (job.status === 'failed') {
                    const message = job.error?.message || '后台生成失败。';
                    toastr.error(message, '酒馆后台通知');
                    await acknowledgeJob(job.id);
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

    const capturedGenerateData = await captureGenerateData(type);
    const requestGenerateData = await prepareBackgroundGenerateData(context.mainApi, type, capturedGenerateData);
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
            },
            providerContext: buildProviderContext(context.mainApi, capturedGenerateData, requestGenerateData),
            bark: buildBarkConfig(),
        }),
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || '启动后台生成失败。');
    }

    const job = await response.json();
    await savePendingJob(job);
    abort(true);

    const notificationHint = buildBarkConfig()
        ? '生成完成后会通过 Bark 通知你。'
        : '稍后回到页面时会自动同步结果。';
    toastr.success(`后台生成已启动。${notificationHint}`, '酒馆后台通知');
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
    settings.barkServerUrl = String($('#tavern_notify_bark_server').val() || DEFAULT_SETTINGS.barkServerUrl);
    settings.barkDeviceKey = String($('#tavern_notify_bark_device').val() || '');
    settings.barkGroup = String($('#tavern_notify_bark_group').val() || '');
    settings.barkSound = String($('#tavern_notify_bark_sound').val() || '');
    settings.barkTitlePrefix = String($('#tavern_notify_title_prefix').val() || '');
    settings.openUrlOnNotification = $('#tavern_notify_open_url').prop('checked');
    saveSettingsDebounced();
}

function loadSettingsIntoUi() {
    const settings = ensureSettings();
    $('#tavern_notify_enabled').prop('checked', settings.enabled);
    $('#tavern_notify_bark_server').val(settings.barkServerUrl);
    $('#tavern_notify_bark_device').val(settings.barkDeviceKey);
    $('#tavern_notify_bark_group').val(settings.barkGroup);
    $('#tavern_notify_bark_sound').val(settings.barkSound);
    $('#tavern_notify_title_prefix').val(settings.barkTitlePrefix);
    $('#tavern_notify_open_url').prop('checked', settings.openUrlOnNotification);
}

async function sendTestNotification() {
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
            },
        }),
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || '发送 Bark 测试通知失败。');
    }

    toastr.success('测试通知已发送到 Bark。', '酒馆后台通知');
}

function bindUi() {
    $('#tavern_notify_enabled').off('change').on('change', onSettingInput);
    $('#tavern_notify_bark_server').off('input').on('input', onSettingInput);
    $('#tavern_notify_bark_device').off('input').on('input', onSettingInput);
    $('#tavern_notify_bark_group').off('input').on('input', onSettingInput);
    $('#tavern_notify_bark_sound').off('input').on('input', onSettingInput);
    $('#tavern_notify_title_prefix').off('input').on('input', onSettingInput);
    $('#tavern_notify_open_url').off('change').on('change', onSettingInput);

    $('#tavern_notify_probe').off('click').on('click', async () => {
        const ok = await probePlugin(true);
        toastr[ok ? 'success' : 'error'](
            ok ? '服务端插件可访问。' : '服务端插件不可访问。',
            '酒馆后台通知',
        );
    });

    $('#tavern_notify_test').off('click').on('click', async () => {
        try {
            await sendTestNotification();
        } catch (error) {
            toastr.error(error instanceof Error ? error.message : '发送测试通知失败。', '酒馆后台通知');
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
            void syncPendingJobs();
        }
    }, POLL_INTERVAL_MS);
}

async function init() {
    ensureSettings();
    await mountSettings();
    await probePlugin(true);
    await syncPendingJobs();

    eventSource.on(event_types.CHAT_CHANGED, syncPendingJobs);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            void syncPendingJobs();
        }
    });

    startPolling();
}

globalThis.TAVERN_NOTIFY_INTERCEPT = backgroundGenerateInterceptor;

jQuery(() => {
    void init();
});
