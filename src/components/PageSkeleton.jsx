import React from 'react';

const Block = ({ className = '' }) => (
    <div className={`animate-pulse bg-gray-200 dark:bg-gray-700 rounded-lg ${className}`} />
);

/**
 * Generic placeholder shown while the initial post-login data fetch
 * (tasks/attendance/leave/contributions/etc.) is still in flight, so the
 * main content area doesn't flash empty-state messages before data arrives.
 */
const PageSkeleton = () => (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6" aria-hidden="true" aria-busy="true">
        <div className="flex items-center justify-between">
            <Block className="h-7 w-48" />
            <Block className="h-9 w-32" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
                <Block key={i} className="h-24" />
            ))}
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 p-5 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
                <Block key={i} className="h-10" />
            ))}
        </div>
    </div>
);

export default PageSkeleton;
