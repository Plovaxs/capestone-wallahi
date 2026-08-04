import React from 'react';

/**
 * Horizontal "how close to a good capture" bar — grows and turns from blue
 * to green as `readiness` (0-100) approaches 100, matching a familiar
 * video-buffer-bar visual language. Purely presentational; callers decide
 * what readiness actually means (pose alignment, framing/lighting quality)
 * via src/vision/scanReadiness.js.
 */
const ScanReadinessBar = ({ readiness = 0, label }) => {
    const clamped = Math.max(0, Math.min(100, readiness));
    const isReady = clamped >= 100;

    return (
        <div className="w-full">
            {label && (
                <div className="flex justify-between items-center mb-1">
                    <span className="text-[9px] font-black uppercase tracking-widest text-gray-400 dark:text-slate-500">{label}</span>
                    {isReady && <span className="text-[9px] font-black uppercase tracking-widest text-emerald-500">✓</span>}
                </div>
            )}
            <div
                role="progressbar"
                aria-valuenow={Math.round(clamped)}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-1.5 w-full rounded-full bg-gray-200 dark:bg-slate-800 overflow-hidden"
            >
                <div
                    className={`h-full rounded-full transition-all duration-150 ease-out ${isReady ? 'bg-emerald-500' : 'bg-blue-500'}`}
                    style={{ width: `${clamped}%` }}
                />
            </div>
        </div>
    );
};

export default ScanReadinessBar;
