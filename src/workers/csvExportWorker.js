/**
 * Web Worker: builds the CSV string off the main thread so exporting a
 * large dataset doesn't freeze the UI while it runs. Pure string work, no
 * DOM access needed — the only DOM-touching step (creating the Blob URL
 * and triggering the browser download) still happens back on the main
 * thread in ExportButton.jsx, since workers can't touch the document.
 */
self.onmessage = (event) => {
    const { columns, data } = event.data;

    const headers = columns.map((c) => c.label).join(',');
    const rows = data.map((row) =>
        columns
            .map((c) => {
                const value = row[c.key];
                const stringValue = value === null || value === undefined ? '' : String(value);
                return `"${stringValue.replace(/"/g, '""')}"`;
            })
            .join(',')
    );

    self.postMessage({ csvContent: [headers, ...rows].join('\n') });
};
