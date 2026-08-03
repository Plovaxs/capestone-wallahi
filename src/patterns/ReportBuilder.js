import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

/**
 * Builder pattern wrapping jsPDF: composes a PDF report step by step via a
 * fluent, chainable API (title -> subtitle -> divider -> table -> footer)
 * instead of each report function repeating the same imperative
 * doc.text()/autoTable() sequence with its own cursor bookkeeping.
 */
export class ReportBuilder {
    constructor({ orientation = 'portrait' } = {}) {
        this.doc = new jsPDF({ unit: 'pt', format: 'a4', orientation });
        this.margin = 40;
        this.cursorY = 50;
    }

    get pageWidth() {
        return this.doc.internal.pageSize.getWidth();
    }

    get pageHeight() {
        return this.doc.internal.pageSize.getHeight();
    }

    addTitle(title) {
        this.doc.setFontSize(16);
        this.doc.setFont(undefined, 'bold');
        this.doc.text(title, this.margin, this.cursorY);
        return this;
    }

    addSubtitle(subtitle) {
        if (!subtitle) return this;
        this.cursorY += 18;
        this.doc.setFontSize(10);
        this.doc.setFont(undefined, 'normal');
        this.doc.setTextColor(100);
        this.doc.text(subtitle, this.margin, this.cursorY);
        return this;
    }

    addDivider() {
        this.cursorY += 12;
        this.doc.setDrawColor(220);
        this.doc.line(this.margin, this.cursorY, this.pageWidth - this.margin, this.cursorY);
        this.cursorY += 20;
        return this;
    }

    addKeyValueRows(rows) {
        this.doc.setFontSize(10);
        this.doc.setTextColor(30);
        rows.forEach(([label, value]) => {
            this.doc.setFont(undefined, 'bold');
            this.doc.text(`${label}:`, this.margin, this.cursorY);
            this.doc.setFont(undefined, 'normal');
            this.doc.text(String(value), this.margin + 110, this.cursorY);
            this.cursorY += 16;
        });
        this.cursorY += 10;
        return this;
    }

    addTable({ head, body, columnStyles } = {}) {
        autoTable(this.doc, {
            startY: this.cursorY,
            margin: { left: this.margin, right: this.margin },
            head,
            body,
            theme: 'grid',
            styles: { fontSize: 8, cellPadding: 5, overflow: 'linebreak' },
            headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
            columnStyles,
        });
        this.cursorY = this.doc.lastAutoTable.finalY + 20;
        if (this.cursorY > 700) {
            this.doc.addPage();
            this.cursorY = 50;
        }
        return this;
    }

    ensureSpace(minRemaining = 40) {
        if (this.cursorY > this.pageHeight - minRemaining) {
            this.doc.addPage();
            this.cursorY = 50;
        }
        return this;
    }

    addParagraph(label, text) {
        this.doc.setFontSize(10);
        this.doc.setFont(undefined, 'bold');
        this.doc.text(label, this.margin, this.cursorY);
        this.doc.setFont(undefined, 'normal');
        const wrapped = this.doc.splitTextToSize(text, this.pageWidth - this.margin * 2);
        this.doc.text(wrapped, this.margin, this.cursorY + 16);
        return this;
    }

    addFooterOnEveryPage(text) {
        const pageCount = this.doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            this.doc.setPage(i);
            this.doc.setFontSize(8);
            this.doc.setTextColor(150);
            this.doc.text(text, this.margin, this.pageHeight - 20);
        }
        return this;
    }

    save(filename) {
        this.doc.save(filename);
        return this.doc;
    }
}
