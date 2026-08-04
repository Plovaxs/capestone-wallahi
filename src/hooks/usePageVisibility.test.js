import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePageVisibility } from './usePageVisibility';

function setVisibilityState(state) {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

describe('usePageVisibility', () => {
    afterEach(() => {
        setVisibilityState('visible');
    });

    it('starts true when the document is visible', () => {
        setVisibilityState('visible');
        const { result } = renderHook(() => usePageVisibility());
        expect(result.current).toBe(true);
    });

    it('starts false when the document is already hidden on mount', () => {
        setVisibilityState('hidden');
        const { result } = renderHook(() => usePageVisibility());
        expect(result.current).toBe(false);
    });

    it('flips to false when the tab is backgrounded, and back to true when it returns', () => {
        setVisibilityState('visible');
        const { result } = renderHook(() => usePageVisibility());
        expect(result.current).toBe(true);

        act(() => {
            setVisibilityState('hidden');
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(result.current).toBe(false);

        act(() => {
            setVisibilityState('visible');
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(result.current).toBe(true);
    });
});
