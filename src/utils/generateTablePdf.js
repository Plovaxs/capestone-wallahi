import { ReportBuilder } from '../patterns/ReportBuilder';

/**
 * Builds and downloads a simple tabular PDF report (attendance log, task
 * list, etc.) from an array of column defs + row objects. Pure client-side
 * (jsPDF via ReportBuilder), mirrors the layout style used by generateReviewPdf.
 */
export function generateTablePdf({ title, subtitle, columns, rows, filename = 'report' }) {
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
