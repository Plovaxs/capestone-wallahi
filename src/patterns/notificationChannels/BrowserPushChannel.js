/**
 * Strategy: native OS notification via the browser's Notification API.
 * Entirely client-side — no push server, no new table, just surfaces
 * already-fetched notification rows as a desktop popup when the user has
 * opted in and granted permission. Silently disables itself wherever the
 * API isn't available (unsupported browser, permission denied).
 */
export class BrowserPushChannel {
    isSupported() {
        return typeof window !== 'undefined' && 'Notification' in window;
    }

    isEnabled() {
        return this.isSupported() && Notification.permission === 'granted';
    }

    async requestPermission() {
        if (!this.isSupported()) return 'unsupported';
        if (Notification.permission === 'granted') return 'granted';
        return Notification.requestPermission();
    }

    send(notification) {
        if (!this.isEnabled()) return;
        new Notification('Employee Tracker', {
            body: notification.message,
            tag: `notification-${notification.id}`,
        });
    }
}
