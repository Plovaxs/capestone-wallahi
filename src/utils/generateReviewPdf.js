import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

/**
 * Builds and downloads a formal PDF report for a single performance
 * evaluation record. Pure client-side (jsPDF) — no server round trip.
 */
export function generateReviewPdf({ evaluation, sections, scoreOptions, employeeName, supervisorName, labels }) {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;

    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.text(labels.reportTitle, margin, 50);

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(100);
    doc.text(labels.reportSubtitle, margin, 68);

    doc.setDrawColor(220);
    doc.line(margin, 80, pageWidth - margin, 80);

    doc.setFontSize(10);
    doc.setTextColor(30);
    const issuedDate = evaluation.created_at ? new Date(evaluation.created_at).toLocaleString() : '-';
    const infoRows = [
        [labels.employee, employeeName],
        [labels.supervisor, supervisorName],
        [labels.issuedOn, issuedDate],
        [labels.finalScore, `${evaluation.final_score} / 100`],
    ];
    let infoY = 100;
    infoRows.forEach(([label, value]) => {
        doc.setFont(undefined, 'bold');
        doc.text(`${label}:`, margin, infoY);
        doc.setFont(undefined, 'normal');
        doc.text(String(value), margin + 110, infoY);
        infoY += 16;
    });

    let cursorY = infoY + 10;

    sections.forEach((section) => {
        const body = section.items.map((item, idx) => {
            const scoreValue = evaluation.scores?.[item.id];
            const matchedLabel = scoreOptions.find((o) => o.val === scoreValue)?.label || labels.unmarked;
            return [String(idx + 1), item.text, matchedLabel];
        });

        autoTable(doc, {
            startY: cursorY,
            margin: { left: margin, right: margin },
            head: [[{ content: section.title, colSpan: 3 }]],
            body,
            theme: 'grid',
            styles: { fontSize: 8, cellPadding: 5, overflow: 'linebreak' },
            headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
            columnStyles: {
                0: { cellWidth: 24, halign: 'center' },
                1: { cellWidth: pageWidth - margin * 2 - 24 - 90 },
                2: { cellWidth: 90, halign: 'center' },
            },
        });

        cursorY = doc.lastAutoTable.finalY + 20;
        if (cursorY > 700) {
            doc.addPage();
            cursorY = 50;
        }
    });

    if (cursorY > 680) {
        doc.addPage();
        cursorY = 50;
    }
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    doc.text(labels.remarks, margin, cursorY);
    doc.setFont(undefined, 'normal');
    const remarksText = doc.splitTextToSize(evaluation.comments || labels.noRemarks, pageWidth - margin * 2);
    doc.text(remarksText, margin, cursorY + 16);

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(labels.generatedOn, margin, doc.internal.pageSize.getHeight() - 20);
    }

    doc.save(`${labels.filenamePrefix}_${employeeName.replace(/\s+/g, '_')}_${evaluation.id}.pdf`);
}
