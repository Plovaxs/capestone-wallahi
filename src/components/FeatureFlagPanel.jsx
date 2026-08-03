import React, { useState, useEffect, useCallback } from 'react';
import Modal from './Modal';
import { featureFlags } from '../feature-flags/FeatureFlagService';
import { registerFeatureFlagPanelOpener } from '../feature-flags/panelOpener';

/**
 * Hidden admin-style panel (opened via the command palette, Ctrl/Cmd+K ->
 * "Feature Flags") that lets flags be toggled at runtime — no redeploy,
 * no database write, just a localStorage override layer read by
 * useFeatureFlag() everywhere a gated feature is rendered.
 */
const FeatureFlagPanel = () => {
    const [isOpen, setIsOpen] = useState(false);
    const [, forceUpdate] = useState(0);

    const open = useCallback(() => setIsOpen(true), []);

    useEffect(() => {
        registerFeatureFlagPanelOpener(open);
    }, [open]);

    useEffect(() => featureFlags.subscribe(() => forceUpdate((n) => n + 1)), []);

    return (
        <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Feature Flags">
            <div className="space-y-3">
                <p className="text-xs text-gray-400 dark:text-gray-500">
                    Runtime toggles, stored per-browser. No redeploy or database change required.
                </p>
                {featureFlags.getAllFlags().map((flag) => (
                    <label key={flag.name} className="flex items-center justify-between gap-3 text-sm font-semibold text-gray-700 dark:text-gray-200">
                        <span className="flex items-center gap-2">
                            {flag.name}
                            {flag.isOverridden && (
                                <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase">overridden</span>
                            )}
                        </span>
                        <input
                            type="checkbox"
                            checked={flag.enabled}
                            onChange={(e) => featureFlags.setOverride(flag.name, e.target.checked)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4"
                        />
                    </label>
                ))}
            </div>
        </Modal>
    );
};

export default FeatureFlagPanel;
