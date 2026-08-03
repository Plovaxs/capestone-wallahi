import React from 'react';

/**
 * Clickable <th> that toggles asc/desc sort on `sortKey` when clicked,
 * showing a directional arrow once it's the active sort column.
 */
const SortableTh = ({ label, sortKey, sortConfig, onSort, className = '' }) => {
    const isActive = sortConfig.key === sortKey;
    const ariaSort = isActive ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending') : 'none';

    return (
        <th className={`p-4 ${className}`} aria-sort={ariaSort}>
            <button
                type="button"
                onClick={() => onSort(sortKey)}
                className="flex items-center gap-1 uppercase tracking-wider font-bold hover:opacity-70 focus:outline-none focus:underline"
            >
                {label}
                <span className={isActive ? '' : 'opacity-30'}>
                    {isActive ? (sortConfig.direction === 'asc' ? '↑' : '↓') : '↕'}
                </span>
            </button>
        </th>
    );
};

export default SortableTh;
