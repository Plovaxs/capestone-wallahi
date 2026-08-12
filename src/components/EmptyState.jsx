import React from 'react';
import { Icons } from './Icons';

// 🟩 DESIGN SYSTEM: shared "nothing here yet" state (icon + title + hint +
// optional action) so empty lists across the app read as an intentional
// design rather than a blank void or a raw "No data" string. Previously
// each screen either had no empty state at all or a bespoke one-off (see
// Header.jsx's notification dropdown, kept as-is since it's already
// bespoke and small -- this is for NEW empty states going forward).
const EmptyState = ({ icon, title, description, action, className = '' }) => (
  <div className={`flex flex-col items-center justify-center text-center py-10 px-4 ${className}`}>
    <div className="h-12 w-12 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-gray-400 dark:text-gray-500 mb-3">
      <span className="h-6 w-6 inline-flex">{icon || Icons.Inbox}</span>
    </div>
    <p className="text-sm font-bold text-gray-600 dark:text-gray-300">{title}</p>
    {description && <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-xs">{description}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export default EmptyState;
