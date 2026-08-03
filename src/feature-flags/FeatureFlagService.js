const STORAGE_KEY = 'feature_flags_overrides';

/**
 * Config-driven feature flags: a default set of flags plus a localStorage
 * override layer, so features can be toggled at runtime (per-browser, for
 * a demo or a gradual rollout) without a redeploy or touching the
 * database. Subscribers re-render whenever a flag changes.
 */
export class FeatureFlagService {
    constructor(defaults = {}) {
        this.defaults = defaults;
        this.listeners = new Set();
        this.overrides = this._loadOverrides();
    }

    _loadOverrides() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    }

    _persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.overrides));
        } catch {
            // localStorage unavailable — flags just won't persist across reloads
        }
    }

    isEnabled(flagName) {
        if (Object.prototype.hasOwnProperty.call(this.overrides, flagName)) {
            return this.overrides[flagName];
        }
        return !!this.defaults[flagName];
    }

    setOverride(flagName, enabled) {
        this.overrides[flagName] = enabled;
        this._persist();
        this.listeners.forEach((listener) => listener());
    }

    clearOverride(flagName) {
        delete this.overrides[flagName];
        this._persist();
        this.listeners.forEach((listener) => listener());
    }

    getAllFlags() {
        return Object.keys(this.defaults).map((name) => ({
            name,
            enabled: this.isEnabled(name),
            isOverridden: Object.prototype.hasOwnProperty.call(this.overrides, name),
        }));
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

export const featureFlags = new FeatureFlagService({
    commandPalette: true,
    dashboardWidgets: true,
    desktopNotifications: true,
    bulkActions: true,
});
