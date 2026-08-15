import React from 'react';

/**
 * Shared tab bar for views that expose their content as several navigable
 * submodules (Overview + N add-ons) instead of one flat page -- same
 * visual/interaction pattern DebugCenterView.jsx pioneered, extracted here
 * so every module that adopts it (see the 2026-08 module-expansion round)
 * looks and behaves identically instead of each view hand-rolling its own
 * copy of this markup.
 */
const ModuleTabBar = ({ tabs, activeTab, onChange }) => (
    <div className="flex gap-2 flex-wrap border-b border-gray-200 dark:border-gray-700 pb-3" role="tablist">
        {tabs.map((tab) => (
            <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => onChange(tab.id)}
                aria-current={activeTab === tab.id ? 'page' : undefined}
                className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-colors ${
                    activeTab === tab.id
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
            >
                <span className="h-4 w-4 inline-flex">{tab.icon}</span>
                {tab.label}
            </button>
        ))}
    </div>
);

export default ModuleTabBar;
