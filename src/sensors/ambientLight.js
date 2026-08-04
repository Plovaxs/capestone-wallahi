const DEFAULT_LOW_LIGHT_LUX_THRESHOLD = 20;

/**
 * The Generic Sensor API's AmbientLightSensor (Chrome desktop/Android only,
 * gated behind a Permissions-Policy header and often a user flag) gives an
 * actual lux reading from the device's light sensor, where one exists —
 * a strictly better low-light signal than inferring darkness from captured
 * pixel brightness after the fact (see vision/faceQuality.js's
 * checkBrightness), since it can flag a dim room *before* the user even
 * starts a scan. Support is rare enough that this must be pure
 * feature-detection with a clean no-op everywhere else.
 */
export function isAmbientLightSensorSupported() {
    return typeof window !== 'undefined' && 'AmbientLightSensor' in window;
}

/** Pure classification, kept separate from the sensor plumbing so it's testable without a real sensor. */
export function classifyLux(lux, lowLightLuxThreshold = DEFAULT_LOW_LIGHT_LUX_THRESHOLD) {
    if (typeof lux !== 'number' || Number.isNaN(lux)) return { lux: null, isLowLight: false };
    return { lux, isLowLight: lux < lowLightLuxThreshold };
}

/**
 * Starts watching the sensor if available. Returns a `{ stop }` handle, or
 * null if the API isn't supported/permitted in this browser — callers
 * should treat null as "no ambient light signal available" and fall back
 * to their existing pixel-brightness-based check entirely.
 */
export function createAmbientLightWatcher({ onReading, onError, lowLightLuxThreshold = DEFAULT_LOW_LIGHT_LUX_THRESHOLD } = {}) {
    if (!isAmbientLightSensorSupported()) return null;

    try {
        // eslint-disable-next-line no-undef -- AmbientLightSensor is a Generic Sensor API global, feature-detected above
        const sensor = new AmbientLightSensor({ frequency: 1 });
        sensor.addEventListener('reading', () => {
            onReading?.(classifyLux(sensor.illuminance, lowLightLuxThreshold));
        });
        sensor.addEventListener('error', (event) => {
            onError?.(event.error);
        });
        sensor.start();
        return { stop: () => sensor.stop() };
    } catch (error) {
        // Permission denied, Permissions-Policy blocked, or no such hardware.
        onError?.(error);
        return null;
    }
}
