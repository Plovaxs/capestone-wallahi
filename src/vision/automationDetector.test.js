import { describe, it, expect, afterEach } from 'vitest';
import { detectAutomation } from './automationDetector';

function defineNavigatorProp(name, value) {
    Object.defineProperty(navigator, name, { value, configurable: true });
}

describe('detectAutomation', () => {
    afterEach(() => {
        // Reset to jsdom's real defaults so tests don't bleed into each other.
        defineNavigatorProp('webdriver', undefined);
    });

    it('is not suspicious for a normal browser (navigator.webdriver unset)', () => {
        expect(detectAutomation().suspicious).toBe(false);
    });

    it('is not suspicious when navigator.webdriver is explicitly false', () => {
        defineNavigatorProp('webdriver', false);
        expect(detectAutomation().suspicious).toBe(false);
    });

    it('is suspicious when navigator.webdriver is true (WebDriver-controlled session)', () => {
        defineNavigatorProp('webdriver', true);
        const result = detectAutomation();
        expect(result.suspicious).toBe(true);
        expect(result.signals.webdriverFlagged).toBe(true);
    });

    it('reports secondary signals without them affecting the suspicious verdict alone', () => {
        // plugins/outerWidth quirks are diagnostic-only -- verdict must stay
        // false even if these look automation-like, since neither is
        // reliable enough alone (real privacy-hardened browsers can trip them too).
        const result = detectAutomation();
        expect(result.suspicious).toBe(false);
        expect(result.signals).toHaveProperty('pluginsEmpty');
        expect(result.signals).toHaveProperty('outerWindowZero');
    });
});
