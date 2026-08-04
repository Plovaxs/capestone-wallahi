import { describe, it, expect, vi, afterEach } from 'vitest';
import { isAmbientLightSensorSupported, classifyLux, createAmbientLightWatcher } from './ambientLight';

describe('isAmbientLightSensorSupported', () => {
    afterEach(() => {
        delete window.AmbientLightSensor;
    });

    it('returns false when the API is absent (the common case in real browsers)', () => {
        expect(isAmbientLightSensorSupported()).toBe(false);
    });

    it('returns true when the API is present', () => {
        window.AmbientLightSensor = class {};
        expect(isAmbientLightSensorSupported()).toBe(true);
    });
});

describe('classifyLux', () => {
    it('flags a dim reading as low light', () => {
        expect(classifyLux(5)).toEqual({ lux: 5, isLowLight: true });
    });

    it('does not flag a well-lit reading', () => {
        expect(classifyLux(300)).toEqual({ lux: 300, isLowLight: false });
    });

    it('respects a custom threshold', () => {
        expect(classifyLux(50, 100)).toEqual({ lux: 50, isLowLight: true });
        expect(classifyLux(150, 100)).toEqual({ lux: 150, isLowLight: false });
    });

    it('handles a missing/invalid reading without throwing', () => {
        expect(classifyLux(undefined)).toEqual({ lux: null, isLowLight: false });
        expect(classifyLux(NaN)).toEqual({ lux: null, isLowLight: false });
    });
});

describe('createAmbientLightWatcher', () => {
    afterEach(() => {
        delete window.AmbientLightSensor;
    });

    it('returns null (clean no-op) when the sensor API is unsupported', () => {
        const watcher = createAmbientLightWatcher({ onReading: vi.fn() });
        expect(watcher).toBeNull();
    });

    it('starts the sensor and forwards classified readings when supported', () => {
        const listeners = {};
        const fakeSensor = {
            illuminance: 8,
            addEventListener: vi.fn((event, cb) => { listeners[event] = cb; }),
            start: vi.fn(),
            stop: vi.fn(),
        };
        window.AmbientLightSensor = vi.fn().mockImplementation(function AmbientLightSensor() { return fakeSensor; });

        const onReading = vi.fn();
        const watcher = createAmbientLightWatcher({ onReading, lowLightLuxThreshold: 20 });

        expect(watcher).not.toBeNull();
        expect(fakeSensor.start).toHaveBeenCalled();

        listeners.reading();
        expect(onReading).toHaveBeenCalledWith({ lux: 8, isLowLight: true });

        watcher.stop();
        expect(fakeSensor.stop).toHaveBeenCalled();
    });

    it('reports construction failure (denied permission, no hardware) via onError and returns null', () => {
        window.AmbientLightSensor = vi.fn().mockImplementation(function AmbientLightSensor() {
            throw new Error('Permission denied');
        });
        const onError = vi.fn();
        const watcher = createAmbientLightWatcher({ onError });
        expect(watcher).toBeNull();
        expect(onError).toHaveBeenCalled();
    });
});
