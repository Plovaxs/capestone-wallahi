// Same registered-opener pattern as feature-flags/panelOpener.js -- lets
// the "?" global shortcut and the command palette both open the same
// panel instance without prop-drilling a setter through App.jsx.
let openHandler = null;

export function registerShortcutsPanelOpener(handler) {
    openHandler = handler;
}

export function openShortcutsPanel() {
    if (!openHandler) {
        console.warn('KeyboardShortcutsPanel not mounted yet.');
        return;
    }
    openHandler();
}
