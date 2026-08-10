/**
 * Builds and downloads a Completion Certificate PDF -- the inverse of the
 * LOA (Letter of Assignment) issued at registration: instead of assigning
 * someone to a contract/internship, this certifies that they completed it.
 * Pure client-side (jsPDF), lazy-loaded for the same reason as
 * generateReviewPdf.js / generateTablePdf.js.
 */
export async function generateCompletionCertificate({
    employeeName, institution, position, department,
    contractStartDate, contractEndDate, supervisorName, labels,
}) {
    const { default: jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const centerX = pageWidth / 2;

    // Decorative border
    doc.setDrawColor(37, 99, 235);
    doc.setLineWidth(3);
    doc.rect(24, 24, pageWidth - 48, pageHeight - 48);
    doc.setLineWidth(0.75);
    doc.rect(34, 34, pageWidth - 68, pageHeight - 68);

    doc.setTextColor(37, 99, 235);
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text(labels.orgName, centerX, 80, { align: 'center' });

    doc.setTextColor(30);
    doc.setFontSize(28);
    doc.setFont(undefined, 'bold');
    doc.text(labels.certificateTitle, centerX, 130, { align: 'center' });

    doc.setFontSize(11);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(90);
    doc.text(labels.presentedTo, centerX, 165, { align: 'center' });

    doc.setFontSize(22);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(20);
    doc.text(employeeName, centerX, 200, { align: 'center' });

    const period = contractStartDate && contractEndDate
        ? `${new Date(contractStartDate).toLocaleDateString('en-GB')} – ${new Date(contractEndDate).toLocaleDateString('en-GB')}`
        : '-';

    doc.setFontSize(11);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(60);
    const bodyText = labels.bodyText({
        position: position || '-',
        department: department || '-',
        institution: institution || '-',
        period,
    });
    const wrapped = doc.splitTextToSize(bodyText, pageWidth - 200);
    doc.text(wrapped, centerX, 240, { align: 'center' });

    const signY = pageHeight - 100;
    doc.setDrawColor(150);
    doc.line(centerX - 130, signY, centerX + 10, signY);
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    doc.text(supervisorName || '-', centerX - 60, signY + 16, { align: 'center' });
    doc.setFont(undefined, 'normal');
    doc.setTextColor(120);
    doc.text(labels.supervisorLabel, centerX - 60, signY + 30, { align: 'center' });

    doc.setFontSize(9);
    doc.setTextColor(150);
    doc.text(`${labels.issuedOn}: ${new Date().toLocaleDateString('en-GB')}`, pageWidth - 60, pageHeight - 40, { align: 'right' });

    doc.save(`${labels.filenamePrefix}_${employeeName.replace(/\s+/g, '_')}.pdf`);
}
