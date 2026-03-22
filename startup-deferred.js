const DEFAULT_IDLE_TIMEOUT_MS = 1000;
const DEFAULT_DELAY_MS = 0;

export function createDeferredStartupScheduler({
    runTasks,
    requestIdleCallbackFn = globalThis.requestIdleCallback?.bind(globalThis),
    cancelIdleCallbackFn = globalThis.cancelIdleCallback?.bind(globalThis),
    setTimeoutFn = globalThis.setTimeout.bind(globalThis),
    clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    delayMs = DEFAULT_DELAY_MS,
    onError = error => {
        console.warn('[Tavern Notify] 延后启动任务执行失败。', error);
    },
} = {}) {
    if (typeof runTasks !== 'function') {
        throw new TypeError('runTasks must be a function.');
    }

    let scheduled = false;
    let idleHandle = null;
    let timerHandle = null;

    function resetPendingHandle() {
        scheduled = false;
        idleHandle = null;
        timerHandle = null;
    }

    function runSafely() {
        if (!scheduled) {
            return;
        }

        resetPendingHandle();

        // 统一包成 Promise，避免异步任务抛错后变成未处理拒绝。
        Promise.resolve()
            .then(() => runTasks())
            .catch(onError);
    }

    function schedule() {
        if (scheduled) {
            return;
        }

        scheduled = true;

        // 优先等浏览器空闲时再跑首屏非关键任务，减少页面可交互时间的竞争。
        if (typeof requestIdleCallbackFn === 'function') {
            idleHandle = requestIdleCallbackFn(() => {
                runSafely();
            }, {
                timeout: idleTimeoutMs,
            });
            return;
        }

        timerHandle = setTimeoutFn(() => {
            runSafely();
        }, delayMs);
    }

    function cancel() {
        if (!scheduled) {
            return;
        }

        if (idleHandle !== null && typeof cancelIdleCallbackFn === 'function') {
            cancelIdleCallbackFn(idleHandle);
        }

        if (timerHandle !== null) {
            clearTimeoutFn(timerHandle);
        }

        resetPendingHandle();
    }

    return {
        schedule,
        cancel,
    };
}
