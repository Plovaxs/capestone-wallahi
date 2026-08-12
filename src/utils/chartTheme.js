// 🟩 DARK-MODE CHARTS: DashboardView/ErrorMonitorView/CorrelationInsightsView
// each hardcoded recharts grid/axis/tooltip colors tuned for light mode only
// (e.g. `stroke="#334155"` grid lines, `#94a3b8` axis text) -- in dark mode
// those low-contrast slate tones nearly disappear against the dark card
// background. One shared theme object per mode instead of three separate
// ad hoc color sets drifting out of sync with each other.
export const CHART_THEME = {
    light: {
        grid: '#e2e8f0',
        axis: '#64748b',
        tooltipBg: '#ffffff',
        tooltipText: '#1e293b',
        tooltipBorder: '#e2e8f0',
    },
    dark: {
        grid: '#334155',
        axis: '#94a3b8',
        tooltipBg: '#1e293b',
        tooltipText: '#f1f5f9',
        tooltipBorder: '#334155',
    },
};

export const getChartTheme = (isDarkMode) => (isDarkMode ? CHART_THEME.dark : CHART_THEME.light);
