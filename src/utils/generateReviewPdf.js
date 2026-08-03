import { ReportBuilder } from '../patterns/ReportBuilder';

/**
 * Builds and downloads a formal PDF report for a single performance
 * evaluation record. Pure client-side (jsPDF via ReportBuilder) — no
 * server round trip.
 */
export function generateReviewPdf({ evaluation, sections, scoreOptions, employeeName, supervisorName, labels }) {
    const builder = new ReportBuilder({ orientation: 'portrait' });

    const issuedDate = evaluation.created_at ? new Date(evaluation.created_at).toLocaleString() : '-';

    builder
        .addTitle(labels.reportTitle)
        .addSubtitle(labels.reportSubtitle)
        .addDivider()
        .addKeyValueRows([
            [labels.employee, employeeName],
            [labels.supervisor, supervisorName],
            [labels.issuedOn, issuedDate],
            [labels.finalScore, `${evaluation.final_score} / 100`],
        ]);

    sections.forEach((section) => {
        const body = section.items.map((item, idx) => {
            const scoreValue = evaluation.scores?.[item.id];
            const matchedLabel = scoreOptions.find((o) => o.val === scoreValue)?.label || labels.unmarked;
            return [String(idx + 1), item.text, matchedLabel];
        });

        builder.addTable({
            head: [[{ content: section.title, colSpan: 3 }]],
            body,
            columnStyles: {
                0: { cellWidth: 24, halign: 'center' },
                1: { cellWidth: builder.pageWidth - builder.margin * 2 - 24 - 90 },
                2: { cellWidth: 90, halign: 'center' },
            },
        });
    });

    builder
        .ensureSpace(60)
        .addParagraph(labels.remarks, evaluation.comments || labels.noRemarks)
        .addFooterOnEveryPage(labels.generatedOn)
        .save(`${labels.filenamePrefix}_${employeeName.replace(/\s+/g, '_')}_${evaluation.id}.pdf`);
}
