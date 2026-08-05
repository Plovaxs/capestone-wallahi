import React from 'react';

/**
 * One small stat card in the Edge Device Diagnostics grid (see
 * EdgeDiagnosticsPanel.jsx) -- a label, a value, an ok/warning dot, and an
 * optional secondary detail line. Purely presentational; callers decide
 * what "ok" means for their particular sensor reading.
 */
const DiagnosticTile = ({ label, value, ok, detail }) => (
    <div className={`rounded-xl border p-2.5 ${ok ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/10'}`}>
        <div className="flex items-center gap-1.5 mb-1">
            <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
            <span className="text-[9px] font-black uppercase tracking-widest text-gray-400 dark:text-slate-500">{label}</span>
        </div>
        <div className={`text-xs font-bold ${ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>{value}</div>
        {detail && <div className="text-[9px] text-gray-400 dark:text-slate-500 mt-0.5 font-mono">{detail}</div>}
    </div>
);

export default DiagnosticTile;
