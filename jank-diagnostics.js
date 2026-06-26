const DEFAULT_FRAME_JANK_THRESHOLD_MS = 34;
const DEFAULT_LONG_TASK_THRESHOLD_MS = 50;
const DEFAULT_MAX_SAMPLES = 80;
const DEFAULT_CONTEXT_SAMPLE_INTERVAL_MS = 1000;
const DEFAULT_SCROLL_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_UPDATE_INTERVAL_MS = 500;

function createDefaultNowFn() {
    if (globalThis.performance && typeof globalThis.performance.now === 'function') {
        return () => globalThis.performance.now();
    }

    return () => Date.now();
}

function toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function roundMs(value) {
    return Math.round(toFiniteNumber(value) * 10) / 10;
}

function limitSamples(samples, maxSamples) {
    const limit = Math.max(1, Number(maxSamples) || DEFAULT_MAX_SAMPLES);
    if (samples.length > limit) {
        samples.splice(0, samples.length - limit);
    }
}

function clonePlainSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        return {};
    }

    const cloned = {};
    for (const [key, value] of Object.entries(snapshot)) {
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
            cloned[key] = value;
        }
    }
    return cloned;
}

function formatValue(value) {
    if (value === undefined || value === null || value === '') {
        return '未知';
    }
    return String(value);
}

function formatMs(value) {
    return `${roundMs(value)}ms`;
}

function maxByNumber(items, selector) {
    let max = 0;
    for (const item of items) {
        max = Math.max(max, toFiniteNumber(selector(item)));
    }
    return roundMs(max);
}

function sumByNumber(items, selector) {
    let sum = 0;
    for (const item of items) {
        sum += toFiniteNumber(selector(item));
    }
    return roundMs(sum);
}

export function createJankDiagnosticsRecorder(options = {}) {
    const nowFn = options.nowFn || createDefaultNowFn();
    const frameJankThresholdMs = options.frameJankThresholdMs ?? DEFAULT_FRAME_JANK_THRESHOLD_MS;
    const longTaskThresholdMs = options.longTaskThresholdMs ?? DEFAULT_LONG_TASK_THRESHOLD_MS;
    const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;

    let running = false;
    let startedAt = null;
    let stoppedAt = null;
    let lastFrameAt = null;
    const frameIntervals = [];
    const longFrames = [];
    const longTasks = [];
    const contextSamples = [];
    const scrollSamples = [];

    function resetSamples() {
        frameIntervals.length = 0;
        longFrames.length = 0;
        longTasks.length = 0;
        contextSamples.length = 0;
        scrollSamples.length = 0;
        lastFrameAt = null;
    }

    function pushSample(samples, sample) {
        samples.push(sample);
        limitSamples(samples, maxSamples);
    }

    return {
        start() {
            if (running) {
                return;
            }

            resetSamples();
            running = true;
            startedAt = roundMs(nowFn());
            stoppedAt = null;
        },

        stop() {
            if (!running) {
                return;
            }

            running = false;
            stoppedAt = roundMs(nowFn());
            lastFrameAt = null;
        },

        clear() {
            running = false;
            startedAt = null;
            stoppedAt = null;
            resetSamples();
        },

        recordFrame(timestamp = nowFn()) {
            if (!running) {
                return;
            }

            const frameAt = roundMs(timestamp);
            if (lastFrameAt !== null) {
                const intervalMs = roundMs(frameAt - lastFrameAt);
                if (intervalMs >= 0) {
                    const sample = {
                        at: frameAt,
                        intervalMs,
                    };
                    pushSample(frameIntervals, sample);

                    if (intervalMs >= frameJankThresholdMs) {
                        pushSample(longFrames, sample);
                    }
                }
            }

            lastFrameAt = frameAt;
        },

        recordLongTask(entry = {}) {
            if (!running) {
                return;
            }

            const durationMs = roundMs(entry.duration);
            if (durationMs < longTaskThresholdMs) {
                return;
            }

            pushSample(longTasks, {
                name: String(entry.name || 'longtask'),
                startTime: roundMs(entry.startTime),
                durationMs,
            });
        },

        recordContext(snapshot = {}) {
            if (!running) {
                return;
            }

            pushSample(contextSamples, {
                at: roundMs(nowFn()),
                data: clonePlainSnapshot(snapshot),
            });
        },

        recordScroll(snapshot = {}) {
            if (!running) {
                return;
            }

            pushSample(scrollSamples, {
                at: roundMs(nowFn()),
                data: clonePlainSnapshot(snapshot),
            });
        },

        getSummary() {
            const endAt = running ? roundMs(nowFn()) : stoppedAt;
            const durationMs = startedAt === null || endAt === null ? 0 : Math.max(0, roundMs(endAt - startedAt));
            const latestContext = contextSamples.length ? contextSamples[contextSamples.length - 1].data : null;
            const latestScroll = scrollSamples.length ? scrollSamples[scrollSamples.length - 1].data : null;
            const totalFrameIntervalMs = sumByNumber(frameIntervals, item => item.intervalMs);
            const averageFrameIntervalMs = frameIntervals.length
                ? roundMs(totalFrameIntervalMs / frameIntervals.length)
                : 0;

            return {
                running,
                startedAt,
                stoppedAt,
                durationMs,
                frameIntervalCount: frameIntervals.length,
                longFrameCount: longFrames.length,
                maxFrameIntervalMs: maxByNumber(frameIntervals, item => item.intervalMs),
                averageFrameIntervalMs,
                longTaskCount: longTasks.length,
                maxLongTaskDurationMs: maxByNumber(longTasks, item => item.durationMs),
                totalLongTaskDurationMs: sumByNumber(longTasks, item => item.durationMs),
                scrollEventCount: scrollSamples.length,
                contextSampleCount: contextSamples.length,
                latestContext,
                latestScroll,
                recentLongTasks: longTasks.slice(-5),
                recentLongFrames: longFrames.slice(-5),
            };
        },

        buildReport(extra = {}) {
            return formatJankDiagnosticReport(this.getSummary(), extra);
        },
    };
}

export function formatJankDiagnosticReport(summary = {}, options = {}) {
    const generatedAt = options.generatedAt || new Date().toISOString();
    const environment = options.environment || {};
    const context = summary.latestContext || {};
    const scroll = summary.latestScroll || {};
    const recentLongTasks = Array.isArray(summary.recentLongTasks) ? summary.recentLongTasks : [];
    const recentLongFrames = Array.isArray(summary.recentLongFrames) ? summary.recentLongFrames : [];
    const lines = [
        '# Tavern Notify 卡顿诊断报告',
        `生成时间: ${generatedAt}`,
        `采样状态: ${summary.running ? '采样中' : '已停止'}`,
        `采样时长: ${formatMs(summary.durationMs)}`,
        '',
        '## 主线程与帧',
        `长任务次数: ${summary.longTaskCount || 0}`,
        `最大长任务: ${formatMs(summary.maxLongTaskDurationMs)}`,
        `长任务总耗时: ${formatMs(summary.totalLongTaskDurationMs)}`,
        `长帧次数: ${summary.longFrameCount || 0}`,
        `最大帧间隔: ${formatMs(summary.maxFrameIntervalMs)}`,
        `平均帧间隔: ${formatMs(summary.averageFrameIntervalMs)}`,
        '',
        '## 聊天上下文',
        `消息数量: ${formatValue(context.messageCount)}`,
        `pending job 数量: ${formatValue(context.pendingJobCount)}`,
        `滚动高度: ${formatValue(context.scrollHeight)}`,
        `可视高度: ${formatValue(context.clientHeight)}`,
        `页面可见状态: ${formatValue(context.visibilityState)}`,
        '',
        '## 最近滚动',
        `scrollTop: ${formatValue(scroll.scrollTop)}`,
        `scrollHeight: ${formatValue(scroll.scrollHeight)}`,
        `clientHeight: ${formatValue(scroll.clientHeight)}`,
        `滚动采样次数: ${summary.scrollEventCount || 0}`,
        '',
        '## 环境',
        `Viewport: ${formatValue(environment.viewport)}`,
        `Device pixel ratio: ${formatValue(environment.devicePixelRatio)}`,
        `User-Agent: ${formatValue(environment.userAgent)}`,
    ];

    if (recentLongTasks.length) {
        lines.push('', '## 最近长任务');
        for (const task of recentLongTasks) {
            lines.push(`- ${task.name}: start=${formatMs(task.startTime)}, duration=${formatMs(task.durationMs)}`);
        }
    }

    if (recentLongFrames.length) {
        lines.push('', '## 最近长帧');
        for (const frame of recentLongFrames) {
            lines.push(`- at=${formatMs(frame.at)}, interval=${formatMs(frame.intervalMs)}`);
        }
    }

    return lines.join('\n');
}

export function createJankDiagnostics(options = {}) {
    const nowFn = options.nowFn || createDefaultNowFn();
    const recorder = createJankDiagnosticsRecorder({
        nowFn,
        frameJankThresholdMs: options.frameJankThresholdMs,
        longTaskThresholdMs: options.longTaskThresholdMs,
        maxSamples: options.maxSamples,
    });
    const requestAnimationFrameFn = options.requestAnimationFrameFn || globalThis.requestAnimationFrame?.bind(globalThis);
    const cancelAnimationFrameFn = options.cancelAnimationFrameFn || globalThis.cancelAnimationFrame?.bind(globalThis);
    const setIntervalFn = options.setIntervalFn || globalThis.setInterval?.bind(globalThis);
    const clearIntervalFn = options.clearIntervalFn || globalThis.clearInterval?.bind(globalThis);
    const PerformanceObserverCtor = options.PerformanceObserverCtor || globalThis.PerformanceObserver;
    const findScrollContainer = options.findScrollContainer || (() => null);
    const getContextSnapshot = options.getContextSnapshot || (() => ({}));
    const getEnvironmentSnapshot = options.getEnvironmentSnapshot || (() => ({}));
    const onUpdate = options.onUpdate || (() => {});
    const contextSampleIntervalMs = options.contextSampleIntervalMs ?? DEFAULT_CONTEXT_SAMPLE_INTERVAL_MS;
    const scrollSampleIntervalMs = options.scrollSampleIntervalMs ?? DEFAULT_SCROLL_SAMPLE_INTERVAL_MS;
    const updateIntervalMs = options.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;

    let running = false;
    let frameRequestId = null;
    let contextTimerId = null;
    let longTaskObserver = null;
    let scrollContainer = null;
    let lastScrollSampleAt = 0;
    let lastUpdateAt = 0;

    function emitUpdate(force = false) {
        const now = nowFn();
        if (!force && now - lastUpdateAt < updateIntervalMs) {
            return;
        }

        lastUpdateAt = now;
        onUpdate(recorder.getSummary());
    }

    function getScrollSnapshot(container) {
        return {
            scrollTop: roundMs(container?.scrollTop),
            scrollHeight: roundMs(container?.scrollHeight),
            clientHeight: roundMs(container?.clientHeight),
        };
    }

    function onScroll() {
        const now = nowFn();
        if (now - lastScrollSampleAt < scrollSampleIntervalMs) {
            return;
        }

        lastScrollSampleAt = now;
        recorder.recordScroll(getScrollSnapshot(scrollContainer));
        emitUpdate(false);
    }

    function detachScrollContainer() {
        if (scrollContainer && typeof scrollContainer.removeEventListener === 'function') {
            scrollContainer.removeEventListener('scroll', onScroll);
        }
        scrollContainer = null;
    }

    function attachScrollContainer() {
        let nextContainer = null;
        try {
            nextContainer = findScrollContainer();
        } catch {
            nextContainer = null;
        }

        if (nextContainer === scrollContainer) {
            return;
        }

        detachScrollContainer();
        scrollContainer = nextContainer;

        if (scrollContainer && typeof scrollContainer.addEventListener === 'function') {
            scrollContainer.addEventListener('scroll', onScroll, { passive: true });
            recorder.recordScroll(getScrollSnapshot(scrollContainer));
        }
    }

    function sampleContext() {
        try {
            recorder.recordContext(getContextSnapshot());
        } catch {
            recorder.recordContext({});
        }

        attachScrollContainer();
        emitUpdate(false);
    }

    function startFrameLoop() {
        if (typeof requestAnimationFrameFn !== 'function') {
            return;
        }

        const onFrame = timestamp => {
            if (!running) {
                return;
            }

            recorder.recordFrame(timestamp);
            emitUpdate(false);
            frameRequestId = requestAnimationFrameFn(onFrame);
        };

        frameRequestId = requestAnimationFrameFn(onFrame);
    }

    function stopFrameLoop() {
        if (frameRequestId !== null && typeof cancelAnimationFrameFn === 'function') {
            cancelAnimationFrameFn(frameRequestId);
        }
        frameRequestId = null;
    }

    function startLongTaskObserver() {
        if (typeof PerformanceObserverCtor !== 'function') {
            return;
        }

        try {
            longTaskObserver = new PerformanceObserverCtor(list => {
                const entries = typeof list?.getEntries === 'function' ? list.getEntries() : [];
                for (const entry of entries) {
                    recorder.recordLongTask(entry);
                }
                emitUpdate(true);
            });
            longTaskObserver.observe({ entryTypes: ['longtask'] });
        } catch {
            longTaskObserver = null;
        }
    }

    function stopLongTaskObserver() {
        if (longTaskObserver && typeof longTaskObserver.disconnect === 'function') {
            longTaskObserver.disconnect();
        }
        longTaskObserver = null;
    }

    function startContextTimer() {
        if (typeof setIntervalFn !== 'function') {
            return;
        }

        contextTimerId = setIntervalFn(sampleContext, contextSampleIntervalMs);
    }

    function stopContextTimer() {
        if (contextTimerId !== null && typeof clearIntervalFn === 'function') {
            clearIntervalFn(contextTimerId);
        }
        contextTimerId = null;
    }

    return {
        start() {
            if (running) {
                return;
            }

            running = true;
            lastScrollSampleAt = 0;
            lastUpdateAt = 0;
            recorder.start();
            sampleContext();
            startFrameLoop();
            startLongTaskObserver();
            startContextTimer();
            emitUpdate(true);
        },

        stop() {
            if (!running) {
                return;
            }

            running = false;
            stopFrameLoop();
            stopLongTaskObserver();
            stopContextTimer();
            detachScrollContainer();
            recorder.stop();
            emitUpdate(true);
        },

        clear() {
            if (running) {
                this.stop();
            }

            recorder.clear();
            emitUpdate(true);
        },

        getSummary() {
            return recorder.getSummary();
        },

        buildReport(extra = {}) {
            return recorder.buildReport({
                generatedAt: new Date().toISOString(),
                environment: getEnvironmentSnapshot(),
                ...extra,
            });
        },
    };
}
