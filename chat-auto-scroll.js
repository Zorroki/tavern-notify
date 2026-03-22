const CHAT_CONTAINER_SELECTORS = [
    '#chat',
    '#chat_messages',
    '#chat_parent',
    '.chat',
    '.chat_messages',
    '.mes_block',
];

const CHAT_MESSAGE_SELECTORS = [
    '#chat .mes',
    '.mes',
    '.message',
    '[data-message-id]',
];

function isViewportElement(element) {
    const nodeName = String(element?.nodeName || '');
    return nodeName === 'BODY' || nodeName === 'HTML';
}

function isScrollableElement(element) {
    if (!element || isViewportElement(element)) {
        return false;
    }

    const scrollHeight = Number(element.scrollHeight || 0);
    const clientHeight = Number(element.clientHeight || 0);
    return scrollHeight > clientHeight;
}

function findFirstMatch(root, selectors) {
    if (!root?.querySelector) {
        return null;
    }

    for (const selector of selectors) {
        const element = root.querySelector(selector);
        if (element) {
            return element;
        }
    }

    return null;
}

function hasMessageContent(root, selectors = CHAT_MESSAGE_SELECTORS) {
    if (!root) {
        return false;
    }

    if (findFirstMatch(root, selectors)) {
        return true;
    }

    return Number(root.childElementCount || 0) > 0;
}

function isReadyChatContainer(container, selectors = CHAT_MESSAGE_SELECTORS) {
    if (!container || isViewportElement(container)) {
        return false;
    }

    if (isScrollableElement(container)) {
        return true;
    }

    // 容器存在但消息 DOM 还没挂好时，不应把这次尝试当成成功。
    return hasMessageContent(container, selectors);
}

export function findNearestScrollableAncestor(element) {
    let currentElement = element?.parentElement || null;

    while (currentElement) {
        if (isScrollableElement(currentElement)) {
            return currentElement;
        }

        currentElement = currentElement.parentElement || null;
    }

    return null;
}

export function findChatScrollContainer(root, options = {}) {
    const containerSelectors = options.containerSelectors || CHAT_CONTAINER_SELECTORS;
    const messageSelectors = options.messageSelectors || CHAT_MESSAGE_SELECTORS;
    const allowPendingContainer = options.allowPendingContainer === true;

    let firstMatchedContainer = null;
    for (const selector of containerSelectors) {
        const container = root?.querySelector?.(selector) || null;
        if (!container) {
            continue;
        }

        if (!firstMatchedContainer) {
            firstMatchedContainer = container;
        }

        if (isReadyChatContainer(container, messageSelectors)) {
            return container;
        }
    }

    const messageNode = findFirstMatch(root, messageSelectors);
    if (messageNode) {
        return findNearestScrollableAncestor(messageNode) || firstMatchedContainer;
    }

    if (firstMatchedContainer && hasMessageContent(firstMatchedContainer, messageSelectors)) {
        return firstMatchedContainer;
    }

    if (allowPendingContainer) {
        return firstMatchedContainer;
    }

    return null;
}

export function findChatScrollObserveRoot(root, options = {}) {
    return findChatScrollContainer(root, {
        ...options,
        allowPendingContainer: true,
    });
}

export function scrollContainerToBottom(container) {
    if (!isReadyChatContainer(container)) {
        return false;
    }

    const top = Number(container.scrollHeight || 0);
    container.scrollTop = top;

    if (typeof container.scrollTo === 'function') {
        container.scrollTo({
            top,
            behavior: 'auto',
        });
    }

    return true;
}

function createAutoScrollTask(options) {
    const {
        taskId,
        findContainer,
        scrollToBottom,
        findObserveRoot,
        root,
        MutationObserverCtor,
        setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
        clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
        retryIntervalMs = 80,
        maxRetryAttempts = 4,
        observeTimeoutMs = 1200,
        log = () => {},
        onSettled = () => {},
    } = options;

    let active = false;
    let retryAttempts = 0;
    let retryTimerId = null;
    let observerTimerId = null;
    let mutationTimerId = null;
    let observer = null;

    function clearTimer(timerId) {
        if (timerId === null || typeof clearTimeoutFn !== 'function') {
            return;
        }

        clearTimeoutFn(timerId);
    }

    function cleanup(reason, extra = null) {
        if (!active) {
            return;
        }

        active = false;
        clearTimer(retryTimerId);
        clearTimer(observerTimerId);
        clearTimer(mutationTimerId);
        retryTimerId = null;
        observerTimerId = null;
        mutationTimerId = null;

        if (observer) {
            observer.disconnect();
            observer = null;
        }

        log('Chat open auto scroll task settled.', {
            taskId,
            reason,
            ...extra,
        });
        onSettled(reason);
    }

    function tryScroll(source) {
        const container = typeof findContainer === 'function' ? findContainer() : null;
        if (!container) {
            log('Chat open auto scroll container not ready.', {
                taskId,
                source,
            });
            return false;
        }

        const didScroll = scrollToBottom(container) !== false;
        if (didScroll) {
            cleanup('scrolled', { source });
        }

        return didScroll;
    }

    function startObserver() {
        if (!active) {
            return;
        }

        const observeRoot = typeof findObserveRoot === 'function' ? findObserveRoot() : root;
        if (!observeRoot || typeof MutationObserverCtor !== 'function') {
            cleanup('observer-unavailable');
            return;
        }

        if (observer) {
            return;
        }

        observer = new MutationObserverCtor(() => {
            if (mutationTimerId !== null) {
                return;
            }

            if (typeof setTimeoutFn !== 'function') {
                void tryScroll('mutation');
                return;
            }

            // 合并同一批 DOM 变更，避免首屏阶段每个 mutation 都触发一次全量扫描。
            mutationTimerId = setTimeoutFn(() => {
                mutationTimerId = null;
                void tryScroll('mutation');
            }, 0);
        });
        observer.observe(observeRoot, {
            childList: true,
            subtree: true,
        });

        if (typeof setTimeoutFn === 'function') {
            observerTimerId = setTimeoutFn(() => {
                cleanup('timeout');
            }, observeTimeoutMs);
        }

        log('Chat open auto scroll observer started.', {
            taskId,
            observeTimeoutMs,
        });
    }

    function scheduleRetry() {
        if (!active) {
            return;
        }

        if (retryAttempts >= maxRetryAttempts || typeof setTimeoutFn !== 'function') {
            startObserver();
            return;
        }

        retryTimerId = setTimeoutFn(() => {
            retryTimerId = null;
            retryAttempts += 1;

            if (tryScroll(`retry-${retryAttempts}`)) {
                return;
            }

            scheduleRetry();
        }, retryIntervalMs);
    }

    return {
        start() {
            if (active) {
                return;
            }

            active = true;
            log('Chat open auto scroll task started.', {
                taskId,
            });

            // 先直接尝试一次，覆盖聊天列表已经完成渲染的常见路径。
            if (tryScroll('immediate')) {
                return;
            }

            // 如果事件先于 DOM 渲染到达，则短时重试几轮，再退化到观察模式。
            scheduleRetry();
        },
        cancel() {
            cleanup('cancelled');
        },
    };
}

export function createChatOpenAutoScroller(options = {}) {
    let currentTask = null;
    let nextTaskId = 0;

    return {
        start() {
            if (currentTask) {
                currentTask.cancel();
            }

            nextTaskId += 1;
            const taskId = nextTaskId;

            if (typeof options.createTask === 'function') {
                currentTask = options.createTask(taskId);
            } else {
                let createdTask = null;
                createdTask = createAutoScrollTask({
                    ...options,
                    taskId,
                    onSettled() {
                        if (currentTask === createdTask) {
                            currentTask = null;
                        }
                    },
                });
                currentTask = createdTask;
            }

            currentTask?.start?.();
        },
        cancel() {
            currentTask?.cancel?.();
            currentTask = null;
        },
    };
}
