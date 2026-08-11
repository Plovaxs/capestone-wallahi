import { InAppChannel } from './InAppChannel';
import { BrowserPushChannel } from './BrowserPushChannel';

/**
 * Strategy pattern context: holds every registered notification channel
 * and fans a notification out to whichever ones are currently enabled.
 * Adding a channel (email digest, Slack webhook, SMS, ...) later means
 * writing one more class with `isEnabled()`/`send()` and registering it
 * here — nothing else in the app needs to change.
 */
export class NotificationDispatcher {
    constructor(channels = [new InAppChannel(), new BrowserPushChannel()]) {
        this.channels = channels;
    }

    dispatch(notification) {
        // 🟩 BUG FIX: one throwing channel (e.g. BrowserPushChannel's `new
        // Notification(...)` throws "Illegal constructor" on Android Chrome,
        // which requires ServiceWorkerRegistration.showNotification()
        // instead) used to abort this forEach entirely -- every channel
        // after it silently never ran, AND the exception propagated up into
        // App.jsx's own fetchNotifications loop, aborting it BEFORE
        // dispatchAppData({type: 'SET_NOTIFICATIONS', ...}) ran, so a
        // successful fetch never even reached app state that poll.
        this.channels.filter((channel) => channel.isEnabled()).forEach((channel) => {
            try {
                channel.send(notification);
            } catch (err) {
                console.error('[notifications] channel failed to send:', err);
            }
        });
    }

    getChannel(ChannelClass) {
        return this.channels.find((channel) => channel instanceof ChannelClass);
    }
}

export const notificationDispatcher = new NotificationDispatcher();
