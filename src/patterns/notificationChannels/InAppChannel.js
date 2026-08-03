/**
 * Strategy: in-app channel. The bell dropdown (Header.jsx) already renders
 * straight from the `notifications` state/table, so this strategy is a
 * deliberate no-op — it exists so the dispatcher has a uniform list of
 * channels to iterate instead of special-casing "the default one".
 */
export class InAppChannel {
    isEnabled() {
        return true;
    }

    send() {
        // No-op: the notification bell already reflects the fetched list.
    }
}
