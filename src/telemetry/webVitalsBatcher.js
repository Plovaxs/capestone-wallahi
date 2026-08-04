import { onCLS, onINP, onLCP, onFCP, onTTFB } from 'web-vitals';

const FLUSH_INTERVAL_MS = 10000;

/**
 * Batches Web Vitals metrics client-side instead of firing one network
 * request per metric as each one arrives. Flushes on a timer, and again
 * immediately on page hide (visibilitychange) so the last partial batch
 * isn't lost when the tab closes before the timer fires.
 *
 * The actual "send" step here just logs the batch — swap it for a real
 * fetch()/navigator.sendBeacon() call to an analytics endpoint once one
 * exists; nothing else about the batching/flush logic needs to change.
 */
class WebVitalsBatcher {
    constructor() {
        this.buffer = [];
        this.timer = null;
    }

    start() {
        onCLS((metric) => this._collect(metric));
        onINP((metric) => this._collect(metric));
        onLCP((metric) => this._collect(metric));
        onFCP((metric) => this._collect(metric));
        onTTFB((metric) => this._collect(metric));

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.flush();
        });
    }

    _collect(metric) {
        this.buffer.push({ name: metric.name, value: metric.value, rating: metric.rating, id: metric.id });
        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
        }
    }

    flush() {
        if (this.buffer.length === 0) return;
        const batch = this.buffer;
        this.buffer = [];
        clearTimeout(this.timer);
        this.timer = null;
        if (import.meta.env.DEV) {
            console.debug('[web-vitals] flushing batch', batch);
        }
    }
}

export const webVitalsBatcher = new WebVitalsBatcher();
