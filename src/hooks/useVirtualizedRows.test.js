import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVirtualizedRows } from './useVirtualizedRows';

describe('useVirtualizedRows', () => {
    it('windows to roughly the viewport size plus overscan when scrolled to top', () => {
        const { result } = renderHook(() => useVirtualizedRows(1000, 50, { overscan: 4, containerHeight: 400 }));
        expect(result.current.startIndex).toBe(0);
        // 400 / 50 = 8 rows visible + 4*2 overscan = 16
        expect(result.current.endIndex).toBe(16);
        expect(result.current.topPadding).toBe(0);
        expect(result.current.bottomPadding).toBe((1000 - 16) * 50);
    });

    it('shifts the window forward as scrollTop increases', () => {
        const { result } = renderHook(() => useVirtualizedRows(1000, 50, { overscan: 4, containerHeight: 400 }));
        act(() => {
            result.current.onScroll({ currentTarget: { scrollTop: 1000 } });
        });
        // scrollTop 1000 / rowHeight 50 = row 20, minus overscan 4 = 16
        expect(result.current.startIndex).toBe(16);
        expect(result.current.topPadding).toBe(16 * 50);
    });

    it('never lets endIndex exceed rowCount', () => {
        const { result } = renderHook(() => useVirtualizedRows(10, 50, { overscan: 4, containerHeight: 400 }));
        expect(result.current.endIndex).toBe(10);
        expect(result.current.bottomPadding).toBe(0);
    });

    it('clamps startIndex to 0 near the top even with overscan', () => {
        const { result } = renderHook(() => useVirtualizedRows(1000, 50, { overscan: 4, containerHeight: 400 }));
        act(() => {
            result.current.onScroll({ currentTarget: { scrollTop: 60 } });
        });
        expect(result.current.startIndex).toBe(0);
    });
});
