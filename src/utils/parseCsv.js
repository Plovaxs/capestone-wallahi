/**
 * Minimal CSV parser -- handles quoted fields (with embedded commas/
 * newlines/escaped quotes) without pulling in a full CSV library for what
 * is, realistically, "supervisor exports a roster from Excel/Sheets."
 * Returns an array of row objects keyed by the header row.
 */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { rows.push(row); row = []; };

    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i];
        if (inQuotes) {
            if (char === '"') {
                if (normalized[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else {
                field += char;
            }
        } else if (char === '"') {
            inQuotes = true;
        } else if (char === ',') {
            pushField();
        } else if (char === '\n') {
            pushField();
            pushRow();
        } else {
            field += char;
        }
    }
    if (field !== '' || row.length > 0) { pushField(); pushRow(); }

    const nonEmptyRows = rows.filter((r) => r.some((cell) => cell.trim() !== ''));
    if (nonEmptyRows.length === 0) return [];

    const headers = nonEmptyRows[0].map((h) => h.trim().toLowerCase());
    return nonEmptyRows.slice(1).map((r) => {
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = (r[idx] || '').trim(); });
        return obj;
    });
}
