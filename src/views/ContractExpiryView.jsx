import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { analyzeContractExpiry } from '../domain/contractExpiryTracker';
import { showUserError } from '../utils/errorHandling';
import { supabase } from '../supabaseClient';

const URGENCY_STYLES = {
    expired: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900/50',
    urgent: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900/50',
    warning: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-900/50',
    ok: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900/50',
};

/**
 * VIEW: ContractExpiryView
 * PURPOSE: Surfaces whose contract/internship period is about to run out
 * -- contract_start_date/contract_end_date have been collected per
 * employee for a while (mandatory at registration now, see
 * LoginPage.jsx), but nothing ever showed "who needs a renewal or
 * offboarding conversation soon" without manually checking every profile.
 * Supervisor-only, purely client-side (analyzes already-fetched allUsers,
 * no new database objects needed).
 */
const ContractExpiryView = ({ userProfile, allUsers = [] }) => {
    const { t } = useTranslation();
    const employeeUsers = useMemo(() => allUsers.filter((u) => u.role === 'employee'), [allUsers]);
    const entries = useMemo(() => analyzeContractExpiry(employeeUsers), [employeeUsers]);
    const [generatingId, setGeneratingId] = useState(null);

    // 🟩 AUTOMATED REMINDERS: upgrades this page from "a supervisor has to
    // remember to check" into proactive -- notifies both the employee and
    // the supervisor once a contract enters the urgent/expired tier. The
    // RPC itself dedupes per tier (migrations/20260810_add_contract_expiry_reminders.sql),
    // this ref just avoids firing the same batch of RPC calls again on
    // every re-render within one page visit.
    const remindedThisVisitRef = useRef(new Set());
    useEffect(() => {
        const urgentEntries = entries.filter((e) => e.urgency === 'urgent' || e.urgency === 'expired');
        urgentEntries.forEach((entry) => {
            if (remindedThisVisitRef.current.has(entry.id)) return;
            remindedThisVisitRef.current.add(entry.id);
            supabase.rpc('send_contract_expiry_reminder', { p_employee_id: entry.id, p_tier: entry.urgency })
                .then(({ data: sent, error }) => {
                    if (!error && sent) toast(t('contractExpiry.reminderSent', { name: entry.name }), { icon: '📨' });
                })
                .catch((err) => console.error('send_contract_expiry_reminder failed:', err.message));
        });
    }, [entries, t]);

    const handleGenerateCertificate = async (entry) => {
        setGeneratingId(entry.id);
        try {
            const { generateCompletionCertificate } = await import('../utils/generateCompletionCertificate');
            await generateCompletionCertificate({
                employeeName: entry.name,
                institution: entry.source,
                position: entry.position,
                department: entry.department,
                contractStartDate: entry.contract_start_date,
                contractEndDate: entry.contract_end_date,
                supervisorName: userProfile.name,
                labels: {
                    orgName: t('contractExpiry.certificateOrgName'),
                    certificateTitle: t('contractExpiry.certificateTitle'),
                    presentedTo: t('contractExpiry.certificatePresentedTo'),
                    bodyText: ({ position, department, institution, period }) => t('contractExpiry.certificateBody', { position, department, institution, period }),
                    supervisorLabel: t('contractExpiry.certificateSupervisorLabel'),
                    issuedOn: t('contractExpiry.certificateIssuedOn'),
                    filenamePrefix: t('contractExpiry.certificateFilenamePrefix'),
                },
            });
            toast.success(t('contractExpiry.certificateGenerated'));
        } catch (error) {
            showUserError('errors.generateCertificate', error);
        } finally {
            setGeneratingId(null);
        }
    };

    const stats = useMemo(() => ({
        expired: entries.filter((e) => e.urgency === 'expired').length,
        urgent: entries.filter((e) => e.urgency === 'urgent').length,
        warning: entries.filter((e) => e.urgency === 'warning').length,
        ok: entries.filter((e) => e.urgency === 'ok').length,
    }), [entries]);

    const describeDays = (entry) => {
        if (entry.urgency === 'expired') return t('contractExpiry.expiredAgo', { days: Math.abs(entry.daysRemaining) });
        if (entry.daysRemaining === 0) return t('contractExpiry.expiresToday');
        return t('contractExpiry.expiresInDays', { days: entry.daysRemaining });
    };

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('contractExpiry.supervisorOnly')}
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('contractExpiry.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('contractExpiry.subtitle')}</p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('contractExpiry.statExpired')}</p>
                    <p className={`text-2xl font-black ${stats.expired > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>{stats.expired}</p>
                </div>
                <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('contractExpiry.statUrgent')}</p>
                    <p className={`text-2xl font-black ${stats.urgent > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-800 dark:text-gray-100'}`}>{stats.urgent}</p>
                </div>
                <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('contractExpiry.statWarning')}</p>
                    <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.warning}</p>
                </div>
                <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('contractExpiry.statOk')}</p>
                    <p className="text-2xl font-black text-gray-800 dark:text-gray-100">{stats.ok}</p>
                </div>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                <div className="p-5 pb-3">
                    <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('contractExpiry.listTitle')}</h2>
                </div>
                {entries.length === 0 ? (
                    <p className="text-center text-xs text-gray-400 py-10 dark:text-gray-500 italic">{t('contractExpiry.noContracts')}</p>
                ) : (
                    <div className="divide-y divide-gray-50 dark:divide-gray-700/40">
                        {entries.map((entry) => (
                            <div key={entry.id} className="p-4 flex items-center justify-between gap-4">
                                <div className="min-w-0">
                                    <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{entry.name}</p>
                                    <p className="text-[10px] text-gray-400 dark:text-gray-500">
                                        {entry.position || t('dashboard.notSet')} &middot; {entry.department || t('dashboard.notSet')} &middot; {new Date(entry.contract_end_date).toLocaleDateString('en-GB')}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <span className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${URGENCY_STYLES[entry.urgency]}`}>
                                        {describeDays(entry)}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => handleGenerateCertificate(entry)}
                                        disabled={generatingId === entry.id}
                                        className="text-[10px] font-bold text-blue-600 hover:text-blue-800 dark:text-blue-400 underline disabled:opacity-40"
                                    >
                                        {generatingId === entry.id ? t('contractExpiry.certificateGenerating') : t('contractExpiry.certificateGenerate')}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default ContractExpiryView;
