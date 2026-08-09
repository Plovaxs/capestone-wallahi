import { describe, it, expect } from 'vitest';
import { createLatencyMonitor } from './inferenceLatencyMonitor';

describe('createLatencyMonitor', () => {
    it('is not ready before the buffer fills', () => {
        const monitor = createLatencyMonitor({ bufferSize: 5 });
        monitor.record(100);
        monitor.record(100);
        expect(monitor.getStats().ready).toBe(false);
    });

    it('is not over budget when average latency is well within it', () => {
        const monitor = createLatencyMonitor({ bufferSize: 5, latencyBudgetMs: 900 });
        for (let i = 0; i < 5; i++) monitor.record(200);
        const stats = monitor.getStats();
        expect(stats.ready).toBe(true);
        expect(stats.avgMs).toBe(200);
        expect(stats.isOverBudget).toBe(false);
    });

    it('flags over-budget once the sustained average exceeds the budget', () => {
        const monitor = createLatencyMonitor({ bufferSize: 5, latencyBudgetMs: 900 });
        for (let i = 0; i < 5; i++) monitor.record(1200);
        expect(monitor.getStats().isOverBudget).toBe(true);
    });

    it('a single slow tick does not immediately flag over-budget (rolling average, not one-shot)', () => {
        const monitor = createLatencyMonitor({ bufferSize: 5, latencyBudgetMs: 900 });
        monitor.record(5000); // one very slow tick
        monitor.record(100);
        monitor.record(100);
        monitor.record(100);
        monitor.record(100);
        // average = (5000+100*4)/5 = 1080 -- actually over in this case;
        // use a case where the average stays under despite one spike
        const monitor2 = createLatencyMonitor({ bufferSize: 10, latencyBudgetMs: 900 });
        monitor2.record(5000);
        for (let i = 0; i < 9; i++) monitor2.record(100);
        // average = (5000 + 900) / 10 = 590 -- under budget despite one huge spike
        expect(monitor2.getStats().isOverBudget).toBe(false);
    });

    it('only keeps the most recent bufferSize samples (rolling window)', () => {
        const monitor = createLatencyMonitor({ bufferSize: 3, latencyBudgetMs: 900 });
        monitor.record(2000);
        monitor.record(2000);
        monitor.record(2000);
        // now push 3 fast samples -- should fully displace the slow ones
        monitor.record(100);
        monitor.record(100);
        monitor.record(100);
        expect(monitor.getStats().avgMs).toBe(100);
        expect(monitor.getStats().isOverBudget).toBe(false);
    });

    it('ignores invalid samples (negative, NaN, non-numeric)', () => {
        const monitor = createLatencyMonitor({ bufferSize: 2 });
        monitor.record(-5);
        monitor.record(NaN);
        monitor.record('100');
        expect(monitor.getStats().ready).toBe(false);
    });

    it('reset() clears the buffer back to not-ready', () => {
        const monitor = createLatencyMonitor({ bufferSize: 3 });
        monitor.record(100);
        monitor.record(100);
        monitor.record(100);
        expect(monitor.getStats().ready).toBe(true);
        monitor.reset();
        expect(monitor.getStats().ready).toBe(false);
    });
});
