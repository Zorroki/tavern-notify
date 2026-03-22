import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createChatOpenAutoScroller,
    findChatScrollContainer,
    findNearestScrollableAncestor,
    scrollContainerToBottom,
} from '../chat-auto-scroll.js';

function createFakeTimers() {
    let nextTimerId = 1;
    const timers = new Map();

    return {
        setTimeoutFn(callback, delay = 0) {
            const timerId = nextTimerId;
            nextTimerId += 1;
            timers.set(timerId, {
                callback,
                delay,
            });
            return timerId;
        },
        clearTimeoutFn(timerId) {
            timers.delete(timerId);
        },
        flushNext() {
            let nextEntry = null;
            for (const entry of timers.entries()) {
                if (!nextEntry) {
                    nextEntry = entry;
                    continue;
                }

                const [, currentTimer] = entry;
                const [, nextTimer] = nextEntry;
                if (currentTimer.delay < nextTimer.delay) {
                    nextEntry = entry;
                }
            }

            if (!nextEntry) {
                return false;
            }

            const [timerId, timer] = nextEntry;
            timers.delete(timerId);
            timer.callback();
            return true;
        },
        getPendingCount() {
            return timers.size;
        },
    };
}

function createFakeMutationObserver() {
    return class FakeMutationObserver {
        static instances = [];

        constructor(callback) {
            this.callback = callback;
            this.disconnected = false;
            FakeMutationObserver.instances.push(this);
        }

        observe(root, options) {
            this.root = root;
            this.options = options;
        }

        disconnect() {
            this.disconnected = true;
        }

        trigger(records = []) {
            this.callback(records, this);
        }
    };
}

test('findChatScrollContainer 优先命中候选容器', () => {
    const chatContainer = {
        scrollHeight: 400,
        clientHeight: 200,
        scrollTop: 0,
    };
    const documentLike = {
        querySelector(selector) {
            return selector === '#chat' ? chatContainer : null;
        },
    };

    assert.equal(findChatScrollContainer(documentLike), chatContainer);
});

test('findChatScrollContainer 会回退到消息节点最近的可滚动父元素', () => {
    const scrollableParent = {
        scrollHeight: 500,
        clientHeight: 200,
        parentElement: null,
    };
    const messageNode = {
        parentElement: {
            scrollHeight: 200,
            clientHeight: 200,
            parentElement: scrollableParent,
        },
    };
    const documentLike = {
        querySelector(selector) {
            if (selector === '.mes') {
                return messageNode;
            }
            return null;
        },
    };

    assert.equal(findChatScrollContainer(documentLike), scrollableParent);
});

test('findNearestScrollableAncestor 只返回真正可滚动的父元素', () => {
    const scrollableParent = {
        scrollHeight: 520,
        clientHeight: 240,
        parentElement: null,
    };
    const messageNode = {
        parentElement: {
            scrollHeight: 200,
            clientHeight: 200,
            parentElement: scrollableParent,
        },
    };

    assert.equal(findNearestScrollableAncestor(messageNode), scrollableParent);
});

test('scrollContainerToBottom 会把容器滚动到底部', () => {
    const container = {
        scrollHeight: 640,
        clientHeight: 200,
        scrollTop: 0,
        scrollTo({ top, behavior }) {
            this.scrollTarget = top;
            this.scrollBehavior = behavior;
        },
    };

    assert.equal(scrollContainerToBottom(container), true);
    assert.equal(container.scrollTop, 640);
    assert.equal(container.scrollTarget, 640);
    assert.equal(container.scrollBehavior, 'auto');
});

test('createChatOpenAutoScroller 在重复 start 时会取消旧任务', () => {
    const events = [];
    const scroller = createChatOpenAutoScroller({
        createTask(taskId) {
            return {
                start() {
                    events.push(`start-${taskId}`);
                },
                cancel() {
                    events.push(`cancel-${taskId}`);
                },
            };
        },
    });

    scroller.start();
    scroller.start();

    assert.deepEqual(events, ['start-1', 'cancel-1', 'start-2']);
});

test('createChatOpenAutoScroller 在观察到聊天节点后会滚动到底部并停止观察', () => {
    const fakeTimers = createFakeTimers();
    const FakeMutationObserver = createFakeMutationObserver();
    const root = { nodeName: 'BODY' };
    const container = {
        scrollHeight: 720,
        clientHeight: 280,
        scrollTop: 0,
        scrollTo({ top }) {
            this.scrollTarget = top;
        },
    };
    let currentContainer = null;

    const scroller = createChatOpenAutoScroller({
        findContainer() {
            return currentContainer;
        },
        scrollToBottom: scrollContainerToBottom,
        root,
        MutationObserverCtor: FakeMutationObserver,
        setTimeoutFn: fakeTimers.setTimeoutFn,
        clearTimeoutFn: fakeTimers.clearTimeoutFn,
        retryIntervalMs: 1,
        maxRetryAttempts: 1,
        observeTimeoutMs: 50,
        log() {
            // 测试里不需要输出调试日志。
        },
    });

    scroller.start();
    assert.equal(fakeTimers.getPendingCount(), 1);

    fakeTimers.flushNext();

    assert.equal(FakeMutationObserver.instances.length, 1);
    assert.equal(FakeMutationObserver.instances[0].root, root);

    currentContainer = container;
    FakeMutationObserver.instances[0].trigger();

    assert.equal(container.scrollTop, 0);
    assert.equal(fakeTimers.getPendingCount(), 2);

    fakeTimers.flushNext();

    assert.equal(container.scrollTop, 720);
    assert.equal(container.scrollTarget, 720);
    assert.equal(FakeMutationObserver.instances[0].disconnected, true);
    assert.equal(fakeTimers.getPendingCount(), 0);
});

test('createChatOpenAutoScroller 在观察阶段会合并连续 mutation 回调', () => {
    const fakeTimers = createFakeTimers();
    const FakeMutationObserver = createFakeMutationObserver();
    const root = { nodeName: 'BODY' };
    let scanCount = 0;

    const scroller = createChatOpenAutoScroller({
        findContainer() {
            scanCount += 1;
            return null;
        },
        scrollToBottom: scrollContainerToBottom,
        root,
        MutationObserverCtor: FakeMutationObserver,
        setTimeoutFn: fakeTimers.setTimeoutFn,
        clearTimeoutFn: fakeTimers.clearTimeoutFn,
        retryIntervalMs: 1,
        maxRetryAttempts: 0,
        observeTimeoutMs: 50,
        log() {
            // 测试里不需要输出调试日志。
        },
    });

    scroller.start();
    assert.equal(scanCount, 1);

    FakeMutationObserver.instances[0].trigger();
    FakeMutationObserver.instances[0].trigger();

    assert.equal(scanCount, 1);
    assert.equal(fakeTimers.getPendingCount(), 2);

    fakeTimers.flushNext();

    assert.equal(scanCount, 2);
});

test('createChatOpenAutoScroller 在观察阶段优先监听待就绪聊天容器', () => {
    const fakeTimers = createFakeTimers();
    const FakeMutationObserver = createFakeMutationObserver();
    const fallbackRoot = { nodeName: 'BODY' };
    const pendingRoot = { nodeName: 'DIV', id: 'chat_parent' };

    const scroller = createChatOpenAutoScroller({
        findContainer() {
            return null;
        },
        findObserveRoot() {
            return pendingRoot;
        },
        scrollToBottom: scrollContainerToBottom,
        root: fallbackRoot,
        MutationObserverCtor: FakeMutationObserver,
        setTimeoutFn: fakeTimers.setTimeoutFn,
        clearTimeoutFn: fakeTimers.clearTimeoutFn,
        retryIntervalMs: 1,
        maxRetryAttempts: 0,
        observeTimeoutMs: 50,
        log() {
            // 测试里不需要输出调试日志。
        },
    });

    scroller.start();

    assert.equal(FakeMutationObserver.instances[0].root, pendingRoot);
});

test('createChatOpenAutoScroller 遇到未就绪容器时不会提前结束任务', () => {
    const fakeTimers = createFakeTimers();
    const pendingContainer = {
        scrollHeight: 0,
        clientHeight: 0,
        scrollTop: 0,
        childElementCount: 0,
        querySelector() {
            return null;
        },
    };
    const readyContainer = {
        scrollHeight: 880,
        clientHeight: 280,
        scrollTop: 0,
        childElementCount: 3,
        querySelector(selector) {
            return selector === '.mes' ? { nodeName: 'DIV' } : null;
        },
        scrollTo({ top }) {
            this.scrollTarget = top;
        },
    };
    let callCount = 0;

    const scroller = createChatOpenAutoScroller({
        findContainer() {
            callCount += 1;
            return callCount === 1 ? pendingContainer : readyContainer;
        },
        scrollToBottom: scrollContainerToBottom,
        setTimeoutFn: fakeTimers.setTimeoutFn,
        clearTimeoutFn: fakeTimers.clearTimeoutFn,
        retryIntervalMs: 1,
        maxRetryAttempts: 1,
        observeTimeoutMs: 50,
        log() {
            // 测试里不需要输出调试日志。
        },
    });

    scroller.start();

    assert.equal(fakeTimers.getPendingCount(), 1);
    fakeTimers.flushNext();

    assert.equal(readyContainer.scrollTop, 880);
    assert.equal(readyContainer.scrollTarget, 880);
    assert.equal(fakeTimers.getPendingCount(), 0);
});
