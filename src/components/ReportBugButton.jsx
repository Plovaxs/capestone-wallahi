import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { supabase } from '../supabaseClient';
import Modal from './Modal';
import Button from './Button';
import { Icons } from './Icons';
import { checkRateLimit, formatRateLimitMessage } from '../utils/rateLimit';
import { sanitizeUserInput } from '../utils/sanitize';
import { showUserError } from '../utils/errorHandling';
import { runAllConnectivityChecks } from '../utils/connectivityChecks';

/**
 * COMPONENT: ReportBugButton
 * PURPOSE: A "report a problem" entry point available to EVERY logged-in
 * user, anywhere in the app -- not just supervisors (Debug Center is
 * supervisor-only, and deliberately technical). A non-technical employee
 * who hits a bug doesn't know what "Hugging Face CDN" or "YOLO" means;
 * this lets them just describe what happened in plain language, while
 * automatically attaching the same diagnostic snapshot Debug Center
 * would need anyway -- browser, current page, recent client errors, and
 * (opt-in, since it's an extra network round trip) a live connectivity
 * check -- so whoever picks up the resulting helpdesk ticket doesn't have
 * to ask "what browser were you using" as the first reply.
 */
const ReportBugButton = ({ userProfile, activeView }) => {
    const { t } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const [description, setDescription] = useState('');
    const [includeConnectivity, setIncludeConnectivity] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    if (!userProfile) return null;

    const resetAndClose = () => {
        setDescription('');
        setIncludeConnectivity(false);
        setIsOpen(false);
    };

    const handleSubmit = async () => {
        if (!description.trim() || isSubmitting) return;
        setIsSubmitting(true);
        try {
            const rateLimit = await checkRateLimit('report-bug', { maxRequests: 5, windowSeconds: 60 });
            if (!rateLimit.allowed) {
                toast.error(formatRateLimitMessage(rateLimit.retryAfterMs));
                return;
            }

            const snapshot = {
                page: activeView || 'unknown',
                userAgent: navigator.userAgent,
                viewport: `${window.innerWidth}x${window.innerHeight}`,
                timestamp: new Date().toISOString(),
            };

            if (includeConnectivity) {
                try {
                    snapshot.connectivity = await runAllConnectivityChecks();
                } catch {
                    snapshot.connectivity = 'failed to run';
                }
            }

            const cleanDescription = sanitizeUserInput(description, { maxLength: 2000 });
            const body = `${cleanDescription}\n\n--- ${t('reportBug.attachedDiagnostics')} ---\n${JSON.stringify(snapshot, null, 2)}`;

            const { error } = await supabase.from('helpdesk_tickets').insert({
                employee_id: userProfile.id,
                title: t('reportBug.ticketTitle', { summary: cleanDescription.slice(0, 60) }),
                contribution: body,
                category: 'Help Request ❓',
                problem_types: ['Software'],
            });

            if (error) {
                showUserError('errors.fileTicket', error);
            } else {
                toast.success(t('reportBug.submitSuccess'));
                resetAndClose();
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <>
            <button
                type="button"
                onClick={() => setIsOpen(true)}
                aria-label={t('reportBug.buttonLabel')}
                title={t('reportBug.buttonLabel')}
                className="fixed bottom-5 right-5 z-40 h-12 w-12 rounded-full bg-red-600 hover:bg-red-700 text-white shadow-lg flex items-center justify-center transition-all hover:scale-105 active:scale-95 no-print"
            >
                <span className="h-5 w-5 inline-flex">{Icons.Bug}</span>
            </button>

            <Modal isOpen={isOpen} onClose={resetAndClose} title={t('reportBug.modalTitle')}>
                <div className="space-y-4">
                    <p className="text-xs text-gray-500 dark:text-gray-400">{t('reportBug.modalDescription')}</p>

                    <div>
                        <label htmlFor="report-bug-description" className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                            {t('reportBug.whatHappened')}
                        </label>
                        <textarea
                            id="report-bug-description"
                            rows={5}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder={t('reportBug.placeholder')}
                            className="w-full p-3 border border-gray-200 dark:border-gray-600 rounded-xl dark:bg-gray-900/40 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm"
                        />
                    </div>

                    <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={includeConnectivity}
                            onChange={(e) => setIncludeConnectivity(e.target.checked)}
                            className="rounded border-gray-300 dark:border-gray-600 text-brand-600 focus:ring-brand-500"
                        />
                        {t('reportBug.includeConnectivity')}
                    </label>

                    <p className="text-[10px] text-gray-400 dark:text-gray-500 italic">{t('reportBug.privacyNote')}</p>

                    <Button className="w-full" onClick={handleSubmit} disabled={!description.trim()} loading={isSubmitting}>
                        {t('reportBug.submit')}
                    </Button>
                </div>
            </Modal>
        </>
    );
};

export default ReportBugButton;
