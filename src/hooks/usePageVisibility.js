import { useEffect, useState } from 'react';

/**
 * Tracks whether this tab is currently the visible one (Page Visibility
 * API). Background timers — notification polling, the attendance
 * scan loop, anything that runs on an interval — have no reason to keep
 * firing while the user isn't even looking at the tab: it burns API
 * quota, CPU, battery, and (for the webcam scan loop) keeps the camera
 * actively capturing for no one. Callers pause on `!isVisible` and
 * resume (with an immediate refresh, not just restarting the timer) when
 * it flips back to `true`.
 */
export function usePageVisibility() {
    const [isVisible, setIsVisible] = useState(
        typeof document === 'undefined' || document.visibilityState !== 'hidden'
    );

    useEffect(() => {
        if (typeof document === 'undefined') return;
        const handleChange = () => setIsVisible(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', handleChange);
        return () => document.removeEventListener('visibilitychange', handleChange);
    }, []);

    return isVisible;
}
