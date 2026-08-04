import { useCallback, useState } from 'react';

/**
 * Minimal windowed-rendering helper for long, ever-growing `<table>` lists
 * (leave request history, performance evaluation archive — these only ever
 * accumulate rows over the lifetime of the app). Renders just the rows
 * currently within the scroll viewport (+ overscan) instead of the full
 * array, keeping the DOM small no matter how many years of records pile up.
 *
 * No new dependency — a fixed row height (Tailwind gives every row in
 * these tables identical padding/line-height) makes a full virtualization
 * library unnecessary for this app's scale.
 */
export function useVirtualizedRows(rowCount, rowHeight, { overscan = 8, containerHeight = 480 } = {}) {
    const [scrollTop, setScrollTop] = useState(0);
    const onScroll = useCallback((e) => setScrollTop(e.currentTarget.scrollTop), []);

    const visibleCount = Math.ceil(containerHeight / rowHeight) + overscan * 2;
    const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const endIndex = Math.min(rowCount, startIndex + visibleCount);

    return {
        onScroll,
        containerHeight,
        topPadding: startIndex * rowHeight,
        bottomPadding: Math.max(0, (rowCount - endIndex) * rowHeight),
        startIndex,
        endIndex,
    };
}
