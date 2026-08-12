import React from 'react';

// 🟩 DESIGN SYSTEM: a shimmer-based skeleton block, for loading states that
// need to preserve layout shape (a list row, an avatar, a stat card) --
// complements the existing whole-page `PageSkeleton.jsx` (used for
// route-level Suspense fallbacks) rather than replacing it. This is for
// component-level "this specific piece of data hasn't arrived yet" states,
// which previously had no shared primitive and fell back to a spinner or
// nothing at all (a layout jump when data arrived).
const Skeleton = ({ className = '' }) => (
  <div
    aria-hidden="true"
    className={`relative overflow-hidden bg-gray-200 dark:bg-gray-700 rounded-md ${className}`}
  >
    <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/40 dark:via-white/10 to-transparent" />
  </div>
);

export const SkeletonRow = ({ avatar = false }) => (
  <div className="flex items-center gap-3 p-3">
    {avatar && <Skeleton className="h-9 w-9 rounded-full shrink-0" />}
    <div className="flex-1 space-y-2">
      <Skeleton className="h-3 w-2/5" />
      <Skeleton className="h-2.5 w-4/5" />
    </div>
  </div>
);

export const SkeletonList = ({ count = 4, avatar = false }) => (
  <div className="divide-y divide-gray-100 dark:divide-gray-700" role="status" aria-label="Loading">
    {Array.from({ length: count }).map((_, i) => <SkeletonRow key={i} avatar={avatar} />)}
  </div>
);

export default Skeleton;
