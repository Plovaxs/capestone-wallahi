// Imperative, Promise-based replacement for window.confirm(), backed by the
// accessible <ConfirmDialogHost /> mounted once in App.jsx. Call it exactly
// like the old confirm() — `if (await confirmDialog('Are you sure?')) { ... }`
// — without needing to thread state/hooks through every call site.
let showHandler = null;

export function registerConfirmHandler(handler) {
    showHandler = handler;
}

export function confirmDialog(message, options = {}) {
    if (!showHandler) {
        console.warn('ConfirmDialogHost not mounted yet; falling back to window.confirm.');
        return Promise.resolve(window.confirm(message));
    }
    return showHandler(message, options);
}
