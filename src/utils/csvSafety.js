// A cell value starting with =, +, -, or @ is interpreted as a formula by
// Excel/Sheets when the exported file is opened — letting ordinary user
// text (a task title, a leave request's "reason" field) execute arbitrary
// formulas/macros on whoever opens the export. Prefixing with a single
// quote forces spreadsheet apps to treat it as literal text; the value
// itself is otherwise untouched. Shared by ExportButton's inline fallback
// and csvExportWorker.js so both paths get the same protection.
const FORMULA_TRIGGER_CHARS = ['=', '+', '-', '@'];

export function sanitizeCsvCell(value) {
    const stringValue = value === null || value === undefined ? '' : String(value);
    if (FORMULA_TRIGGER_CHARS.includes(stringValue[0])) {
        return `'${stringValue}`;
    }
    return stringValue;
}
