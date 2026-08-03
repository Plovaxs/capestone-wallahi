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
        this.channels.filter((channel) => channel.isEnabled()).forEach((channel) => channel.send(notification));
    }

    getChannel(ChannelClass) {
        return this.channels.find((channel) => channel instanceof ChannelClass);
    }
}

export const notificationDispatcher = new NotificationDispatcher();
