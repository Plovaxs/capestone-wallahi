import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCircuitBreaker } from './circuitBreaker';

describe('createCircuitBreaker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('passes through successful calls unchanged', async () => {
        const breaker = createCircuitBreaker();
        const result = await breaker(async () => 'ok');
        expect(result).toBe('ok');
    });

    it('trips OPEN after failureThreshold consecutive failures', async () => {
        const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
        const failing = () => Promise.reject(new Error('boom'));

        await expect(breaker(failing)).rejects.toThrow('boom');
        await expect(breaker(failing)).rejects.toThrow('boom');
        await expect(breaker(failing)).rejects.toThrow('boom');

        // 4th call should short-circuit without even calling `failing` again
        const spy = vi.fn(failing);
        await expect(breaker(spy)).rejects.toThrow('Circuit breaker open');
        expect(spy).not.toHaveBeenCalled();
    });

    it('does not trip before the failure threshold is reached', async () => {
        const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
        const failing = () => Promise.reject(new Error('boom'));

        await expect(breaker(failing)).rejects.toThrow('boom');

        const spy = vi.fn(() => Promise.resolve('ok'));
        expect(await breaker(spy)).toBe('ok');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('allows a probe through after the cooldown elapses, and closes on success', async () => {
        const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
        await expect(breaker(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

        vi.advanceTimersByTime(1001);
        const result = await breaker(() => Promise.resolve('recovered'));
        expect(result).toBe('recovered');

        // Circuit is closed again — failures reset, no short-circuit
        const spy = vi.fn(() => Promise.resolve('ok'));
        expect(await breaker(spy)).toBe('ok');
    });

    it('doubles the cooldown when a HALF_OPEN probe itself fails (adaptive backoff)', async () => {
        const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, maxCooldownMs: 100000 });
        await expect(breaker(() => Promise.reject(new Error('first')))).rejects.toThrow('first');

        vi.advanceTimersByTime(1001);
        // Probe fails too — cooldown should double to ~2000ms
        await expect(breaker(() => Promise.reject(new Error('probe failed')))).rejects.toThrow('probe failed');

        vi.advanceTimersByTime(1001); // only the original 1000ms window — should still be short-circuited
        await expect(breaker(() => Promise.resolve('ok'))).rejects.toThrow('Circuit breaker open');

        vi.advanceTimersByTime(1000); // now past the doubled ~2000ms window
        const result = await breaker(() => Promise.resolve('finally recovered'));
        expect(result).toBe('finally recovered');
    });

    it('caps the adaptive backoff at maxCooldownMs', async () => {
        const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, maxCooldownMs: 1500 });
        await expect(breaker(() => Promise.reject(new Error('first')))).rejects.toThrow('first');

        vi.advanceTimersByTime(1001);
        // Probe fails — would double to 2000ms but capped at maxCooldownMs (1500ms)
        await expect(breaker(() => Promise.reject(new Error('probe failed')))).rejects.toThrow('probe failed');

        vi.advanceTimersByTime(1501);
        const result = await breaker(() => Promise.resolve('recovered'));
        expect(result).toBe('recovered');
    });

    it('resets the backoff to the base cooldown after a full recovery', async () => {
        const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, maxCooldownMs: 100000 });
        await expect(breaker(() => Promise.reject(new Error('first')))).rejects.toThrow('first');
        vi.advanceTimersByTime(1001);
        await breaker(() => Promise.resolve('recovered'));

        // Trip again from scratch — should use the base cooldown, not a leftover doubled one
        await expect(breaker(() => Promise.reject(new Error('second')))).rejects.toThrow('second');
        vi.advanceTimersByTime(1001);
        const result = await breaker(() => Promise.resolve('ok again'));
        expect(result).toBe('ok again');
    });
});
