const WEB_PUSH_ROUTE = '/api/plugins/tavern-notify/webpush';
const DEFAULT_TITLE = '酒馆后台通知';
const DEFAULT_BODY = '回复已生成，请回到酒馆查看。';

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        await reportDebugEvent('sw-install');
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        await reportDebugEvent('sw-activate');
        await self.clients.claim();
    })());
});

self.addEventListener('push', event => {
    event.waitUntil(handlePush(event));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(focusOrOpenClient(event.notification.data?.url));
});

async function handlePush(event) {
    try {
        const subscription = await self.registration.pushManager.getSubscription();
        await reportDebugEvent('push-received', {
            endpoint: subscription?.endpoint || '',
            detail: event?.data ? 'with-data' : 'without-data',
        });

        const payload = parsePushPayload(event);
        if (payload) {
            await showNotification(payload);
            return;
        }

        if (!subscription?.endpoint) {
            await showNotification({
                title: DEFAULT_TITLE,
                body: '已收到网页通知，但当前订阅状态异常。',
                tag: 'tavern-notify-fallback',
                data: {},
            });
            await reportDebugEvent('push-missing-subscription');
            return;
        }

        const requestUrl = new URL(`${WEB_PUSH_ROUTE}/pull`, self.location.origin);
        requestUrl.searchParams.set('endpoint', subscription.endpoint);
        await reportDebugEvent('pull-start', {
            endpoint: subscription.endpoint,
        });

        const response = await fetch(requestUrl, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
        });
        if (!response.ok) {
            throw new Error(`Failed to pull Web Push notifications: ${response.status}`);
        }

        const payloadBody = await response.json().catch(() => ({}));
        const notifications = Array.isArray(payloadBody?.notifications) ? payloadBody.notifications : [];
        await reportDebugEvent('pull-success', {
            endpoint: subscription.endpoint,
            detail: `count=${notifications.length}`,
        });
        for (const notification of notifications) {
            await showNotification(notification);
        }
    } catch (error) {
        console.error('[Tavern Notify] Web Push handling failed.', error);
        await reportDebugEvent('push-error', {
            detail: error instanceof Error ? error.message : String(error),
        });
        await showNotification({
            title: DEFAULT_TITLE,
            body: '网页通知已到达，但处理失败，请回到酒馆查看。',
            tag: 'tavern-notify-error',
            data: {},
        });
    }
}

function parsePushPayload(event) {
    if (!event?.data) {
        return null;
    }

    try {
        const json = event.data.json();
        if (json && typeof json === 'object') {
            return {
                title: typeof json.title === 'string' ? json.title : DEFAULT_TITLE,
                body: typeof json.body === 'string' ? json.body : DEFAULT_BODY,
                tag: typeof json.tag === 'string' ? json.tag : '',
                data: typeof json.data === 'object' && json.data ? json.data : {},
            };
        }
    } catch {
        try {
            const text = event.data.text();
            if (text.trim()) {
                return {
                    title: DEFAULT_TITLE,
                    body: text.trim(),
                    tag: 'tavern-notify-text-payload',
                    data: {},
                };
            }
        } catch {
            return null;
        }
    }

    return null;
}

async function showNotification(notification) {
    const subscription = await self.registration.pushManager.getSubscription();
    await reportDebugEvent('notification-show', {
        detail: notification?.title || DEFAULT_TITLE,
        endpoint: subscription?.endpoint || '',
    });
    await self.registration.showNotification(
        notification?.title || DEFAULT_TITLE,
        {
            body: notification?.body || DEFAULT_BODY,
            tag: notification?.tag || undefined,
            data: notification?.data || {},
        },
    );

    if (subscription?.endpoint && notification?.data?.notificationId) {
        await acknowledgeNotification(subscription.endpoint, notification.data.notificationId);
    }
}

async function focusOrOpenClient(url) {
    const targetUrl = normalizeUrl(url) || self.location.origin;
    const windowClients = await clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
    });

    const existingClient = pickClient(windowClients, targetUrl);
    if (existingClient) {
        if (existingClient.url !== targetUrl && 'navigate' in existingClient) {
            await existingClient.navigate(targetUrl);
        }

        if ('focus' in existingClient) {
            await existingClient.focus();
        }

        await reportDebugEvent('notification-click', {
            detail: targetUrl,
        });
        return;
    }

    await reportDebugEvent('notification-click-open', {
        detail: targetUrl,
    });
    await clients.openWindow(targetUrl);
}

function pickClient(windowClients, targetUrl) {
    if (!windowClients.length) {
        return null;
    }

    const exactMatch = windowClients.find(client => client.url === targetUrl);
    if (exactMatch) {
        return exactMatch;
    }

    try {
        const targetOrigin = new URL(targetUrl).origin;
        const sameOriginMatch = windowClients.find(client => {
            try {
                return new URL(client.url).origin === targetOrigin;
            } catch {
                return false;
            }
        });
        if (sameOriginMatch) {
            return sameOriginMatch;
        }
    } catch {
        return windowClients[0];
    }

    return windowClients[0];
}

function normalizeUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return '';
    }

    try {
        return new URL(value, self.location.origin).toString();
    } catch {
        return '';
    }
}

async function reportDebugEvent(event, { endpoint = '', detail = '' } = {}) {
    try {
        const requestUrl = new URL(`${WEB_PUSH_ROUTE}/debug-event`, self.location.origin);
        requestUrl.searchParams.set('event', event);
        if (endpoint) {
            requestUrl.searchParams.set('endpoint', endpoint);
        }
        if (detail) {
            requestUrl.searchParams.set('detail', detail);
        }

        await fetch(requestUrl, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
        });
    } catch {
        // Ignore debug reporting failures to avoid breaking notifications.
    }
}

async function acknowledgeNotification(endpoint, notificationId) {
    try {
        await fetch(`${WEB_PUSH_ROUTE}/ack`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'same-origin',
            body: JSON.stringify({
                endpoint,
                notificationId,
            }),
        });
    } catch {
        // Ignore acknowledgement failures to avoid breaking notifications.
    }
}
