import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { sanitizeCsvCell } from '../utils/csvSafety';

/**
 * Builds the CSV string on a Web Worker so serializing a large dataset
 * doesn't block the main thread / freeze the UI. Falls back to building
 * it inline (same logic) if Workers are unavailable or fail to spin up —
 * this must never be the reason an export silently doesn't happen.
 */
function buildCsvOffThread(columns, data) {
    return new Promise((resolve, reject) => {
        try {
            const worker = new Worker(new URL('../workers/csvExportWorker.js', import.meta.url), { type: 'module' });
            worker.onmessage = (event) => {
                resolve(event.data.csvContent);
                worker.terminate();
            };
            worker.onerror = (err) => {
                reject(err);
                worker.terminate();
            };
            worker.postMessage({ columns, data });
        } catch (err) {
            reject(err);
        }
    });
}

function buildCsvInline(columns, data) {
    const headers = columns.map((c) => c.label).join(',');
    const rows = data.map((row) =>
        columns
            .map((c) => `"${sanitizeCsvCell(row[c.key]).replace(/"/g, '""')}"`)
            .join(',')
    );
    return [headers, ...rows].join('\n');
}

/**
 * COMPONENT: ExportButton
 * PURPOSE: Reusable "handpicked" CSV exporter.
 * Opens a column picker before downloading so the user chooses exactly
 * which fields go into the file, instead of dumping every column blind.
 * Used as-is by TasksView, AttendanceView, and LeaveView — each just
 * passes its already-curated `data` array; `columns` is optional and
 * only needed if you want custom labels/order instead of auto-derived
 * ones from the first row's keys.
 */
const ExportButton = ({ data, filename = 'report', label = 'Export to CSV', columns }) => {
    const { t } = useTranslation();
    const [isPickerOpen, setIsPickerOpen] = useState(false);
    const [selectedKeys, setSelectedKeys] = useState(null);
    const [isDownloading, setIsDownloading] = useState(false);

    const availableColumns = useMemo(() => {
        if (columns && columns.length > 0) return columns;
        if (!data || data.length === 0) return [];
        return Object.keys(data[0]).map((key) => ({ key, label: key }));
    }, [columns, data]);

    const openPicker = () => {
        if (!data || data.length === 0) {
            toast.error(t('export.noData'));
            return;
        }
        setSelectedKeys(new Set(availableColumns.map((c) => c.key)));
        setIsPickerOpen(true);
    };

    const toggleColumn = (key) => {
        setSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const selectAll = () => setSelectedKeys(new Set(availableColumns.map((c) => c.key)));
    const selectNone = () => setSelectedKeys(new Set());

    const handleDownload = async () => {
        // 🟩 DOUBLE-SUBMIT GUARD: the Download button had no in-flight
        // tracking — a double-click while buildCsvOffThread's await was
        // pending spun up two concurrent Web Workers and triggered two
        // simultaneous file downloads.
        if (isDownloading) return;
        if (!selectedKeys || selectedKeys.size === 0) {
            toast.error(t('export.noColumnsSelected'));
            return;
        }

        setIsDownloading(true);
        try {
            const chosenColumns = availableColumns.filter((c) => selectedKeys.has(c.key));

            let csvContent;
            try {
                csvContent = await buildCsvOffThread(chosenColumns, data);
            } catch {
                csvContent = buildCsvInline(chosenColumns, data);
            }

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `${filename}_${new Date().toISOString().slice(0, 10)}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            setIsPickerOpen(false);
        } finally {
            setIsDownloading(false);
        }
    };

    return (
        <>
            <button
                onClick={openPicker}
                className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg shadow-sm transition-all text-sm border border-green-700"
                title="Download as Excel/CSV"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                {label}
            </button>

            <Modal isOpen={isPickerOpen} onClose={() => setIsPickerOpen(false)} title="Choose columns to export">
                <div className="space-y-3">
                    <div className="flex gap-3 text-xs">
                        <button type="button" onClick={selectAll} className="text-blue-600 hover:underline dark:text-blue-400">
                            Select all
                        </button>
                        <span className="text-gray-300 dark:text-gray-600">|</span>
                        <button type="button" onClick={selectNone} className="text-blue-600 hover:underline dark:text-blue-400">
                            Clear all
                        </button>
                    </div>

                    <div className="max-h-64 overflow-y-auto grid grid-cols-2 gap-2 border border-gray-100 dark:border-gray-700 rounded-lg p-3">
                        {availableColumns.map((col) => (
                            <label key={col.key} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={selectedKeys?.has(col.key) ?? false}
                                    onChange={() => toggleColumn(col.key)}
                                    className="rounded"
                                />
                                {col.label}
                            </label>
                        ))}
                    </div>

                    <p className="text-xs text-gray-400 dark:text-gray-500">{data?.length || 0} row(s) will be exported.</p>

                    <div className="flex justify-end gap-2 pt-2">
                        <button
                            type="button"
                            onClick={() => setIsPickerOpen(false)}
                            className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={handleDownload}
                            disabled={isDownloading}
                            className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isDownloading ? 'Downloading…' : 'Download CSV'}
                        </button>
                    </div>
                </div>
            </Modal>
        </>
    );
};

export default ExportButton;