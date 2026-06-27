import React from 'react';

const ExportButton = ({ data, filename = 'report', label = 'Export to CSV' }) => {
    
    const handleDownload = () => {
        if (!data || data.length === 0) {
            alert("No data available to export.");
            return;
        }

        // 1. Extract Headers from the first object
        const headers = Object.keys(data[0]).join(",");
        
        // 2. Format Rows (Handle text with commas by wrapping in quotes)
        const rows = data.map(row => 
            Object.values(row).map(value => {
                const stringValue = value === null || value === undefined ? "" : String(value);
                // Escape double quotes by doubling them, and wrap content in quotes
                return `"${stringValue.replace(/"/g, '""')}"`; 
            }).join(",")
        );

        // 3. Combine Headers and Rows
        const csvContent = [headers, ...rows].join("\n");

        // 4. Create Blob and Trigger Download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.setAttribute("download", `${filename}_${new Date().toISOString().slice(0,10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    return (
        <button 
            onClick={handleDownload}
            className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg shadow-sm transition-all text-sm border border-green-700"
            title="Download as Excel/CSV"
        >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {label}
        </button>
    );
};

export default ExportButton;