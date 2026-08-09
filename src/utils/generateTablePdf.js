/**
 * Builds and downloads a simple tabular PDF report (attendance log, task
 * list, etc.) from an array of column defs + row objects. Pure client-side
 * (jsPDF via ReportBuilder), mirrors the layout style used by generateReviewPdf.
 *
 * 🟩 LAZY-LOADED: jsPDF + jspdf-autotable (ReportBuilder's dependencies)
 * are a genuinely heavy chunk (400KB+) that every caller of this function
 * previously pulled in statically -- meaning AttendanceView/TasksView
 * downloaded it just from being opened, even for the (typical) visit that
 * never touches "Export PDF" at all. Dynamic import means it's only
 * fetched the moment someone actually clicks the button, same pattern
 * already used for face-api.js/@huggingface/transformers.
 */
export async function generateTablePdf({ title, subtitle, columns, rows, filename = 'report' }) {
    const { ReportBuilder } = await import('../patterns/ReportBuilder');
    new ReportBuilder({ orientation: columns.length > 5 ? 'landscape' : 'portrait' })
        .addTitle(title)
        .addSubtitle(subtitle)
        .addDivider()
        .addTable({
            head: [columns.map((c) => c.label)],
            body: rows.map((row) => columns.map((c) => {
                const value = c.key.split('.').reduce((obj, k) => obj?.[k], row);
                return value === null || value === undefined ? '' : String(value);
            })),
        })
        .addFooterOnEveryPage(`Generated on ${new Date().toLocaleString()}`)
        .save(`${filename}_${new Date().toISOString().slice(0, 10)}.pdf`);
}
