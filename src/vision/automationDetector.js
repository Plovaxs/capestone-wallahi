/**
 * Anti-automation detection: closes an attack vector none of this app's
 * other liveness work touches -- a scripted browser (Selenium, Puppeteer,
 * Playwright) driving the page programmatically to feed a synthetic/
 * injected video stream at the camera checks, bypassing a human ever
 * actually sitting in front of it. Complements the passive/active
 * liveness fusion (vision/livenessFusion.js), which assumes a real human
 * is operating a real browser and focuses on distinguishing a live face
 * from a photo/screen -- this instead asks whether the BROWSER ITSELF is
 * being remote-controlled at all.
 *
 * `navigator.webdriver` is the primary, authoritative signal: it's a
 * standard W3C WebDriver spec property that real, human-driven browser
 * sessions never set true -- Chrome/Firefox/Edge only report it true when
 * the page is genuinely under WebDriver automation control. Effectively
 * zero false-positive rate for real users, which is why this is treated
 * as a hard signal rather than one more vote in a fusion (unlike this
 * app's other, individually-noisier heuristics).
 *
 * The two secondary signals are diagnostic-only (surfaced, never gating)
 * -- both have real false-positive risk against legitimate minimal/
 * privacy-hardened browsers, so they're not trustworthy enough alone to
 * block a real user.
 */
export function detectAutomation() {
    const webdriverFlagged = typeof navigator !== 'undefined' && navigator.webdriver === true;

    // Headless/automated browsers frequently report zero plugins and a
    // zero-sized outer window (no real window chrome exists) -- neither is
    // conclusive alone (some real, privacy-hardened browsers report zero
    // plugins too), kept as non-blocking diagnostic signals only.
    const pluginsEmpty = typeof navigator !== 'undefined' && navigator.plugins ? navigator.plugins.length === 0 : null;
    const outerWindowZero = typeof window !== 'undefined' ? (window.outerWidth === 0 || window.outerHeight === 0) : null;

    return {
        suspicious: webdriverFlagged,
        signals: { webdriverFlagged, pluginsEmpty, outerWindowZero },
    };
}
