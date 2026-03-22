import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeferredStartupScheduler } from '../startup-deferred.js';

function flushMicrotasks() {
    return Promise.resolve();
}

test('createDeferredStartupScheduler 会优先使用 requestIdleCallback 延后执行任务', async () => {
    const idleCallbacks = [];
    const runOrder = [];
    const scheduler = createDeferredStartupScheduler({
        runTasks() {
            runOrder.push('run');
        },
        requestIdleCallbackFn(callback, options) {
            idleCallbacks.push({
                callback,
                options,
            });
            return idleCallbacks.length;
        },
        setTimeoutFn() {
            throw new Error('存在 requestIdleCallback 时不应回退到 setTimeout');
        },
    });

    scheduler.schedule();

    assert.deepEqual(runOrder, []);
    assert.equal(idleCallbacks.length, 1);
    assert.equal(idleCallbacks[0].options.timeout, 1000);

    idleCallbacks[0].callback();
    await flushMicrotasks();

    assert.deepEqual(runOrder, ['run']);
});

test('createDeferredStartupScheduler 在回退到 setTimeout 时会合并重复调度', async () => {
    const pendingTimers = [];
    const runOrder = [];
    const scheduler = createDeferredStartupScheduler({
        runTasks() {
            runOrder.push('run');
        },
        requestIdleCallbackFn: undefined,
        setTimeoutFn(callback, delay) {
            pendingTimers.push({
                callback,
                delay,
            });
            return pendingTimers.length;
        },
        clearTimeoutFn() {
            // 这个用例不会走到清理逻辑。
        },
    });

    scheduler.schedule();
    scheduler.schedule();

    assert.deepEqual(runOrder, []);
    assert.equal(pendingTimers.length, 1);
    assert.equal(pendingTimers[0].delay, 0);

    pendingTimers[0].callback();
    await flushMicrotasks();

    assert.deepEqual(runOrder, ['run']);
});
