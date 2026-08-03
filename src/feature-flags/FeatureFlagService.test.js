import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureFlagService } from './FeatureFlagService';

describe('FeatureFlagService', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('falls back to the default when there is no override', () => {
        const service = new FeatureFlagService({ demo: true, off: false });
        expect(service.isEnabled('demo')).toBe(true);
        expect(service.isEnabled('off')).toBe(false);
    });

    it('an override takes precedence over the default', () => {
        const service = new FeatureFlagService({ demo: true });
        service.setOverride('demo', false);
        expect(service.isEnabled('demo')).toBe(false);
    });

    it('persists overrides to localStorage and a new instance picks them up', () => {
        const service = new FeatureFlagService({ demo: true });
        service.setOverride('demo', false);

        const rehydrated = new FeatureFlagService({ demo: true });
        expect(rehydrated.isEnabled('demo')).toBe(false);
    });

    it('clearOverride reverts to the default', () => {
        const service = new FeatureFlagService({ demo: true });
        service.setOverride('demo', false);
        service.clearOverride('demo');
        expect(service.isEnabled('demo')).toBe(true);
    });

    it('notifies subscribers when a flag changes', () => {
        const service = new FeatureFlagService({ demo: true });
        let notified = false;
        service.subscribe(() => { notified = true; });

        service.setOverride('demo', false);
        expect(notified).toBe(true);
    });

    it('getAllFlags reports whether each flag is overridden', () => {
        const service = new FeatureFlagService({ demo: true });
        service.setOverride('demo', false);
        const flags = service.getAllFlags();
        expect(flags).toEqual([{ name: 'demo', enabled: false, isOverridden: true }]);
    });
});
