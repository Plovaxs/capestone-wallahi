let openHandler = null;

/** Registered once by <FeatureFlagPanel/> when it mounts (see ConfirmDialogHost for the same pattern). */
export function registerFeatureFlagPanelOpener(handler) {
    openHandler = handler;
}

export function openFeatureFlagPanel() {
    if (!openHandler) {
        console.warn('FeatureFlagPanel not mounted yet.');
        return;
    }
    openHandler();
}
