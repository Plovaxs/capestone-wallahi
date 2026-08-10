import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { analyzeOnboardingCompletion } from '../domain/onboardingCompletionTracker';

const CHECKLIST_LABELS = {
    position: 'checklistPosition',
    department: 'checklistDepartment',
    institution: 'checklistInstitution',
    contractDates: 'checklistContractDates',
    loaDocument: 'checklistLoaDocument',
    firstClockIn: 'checklistFirstClockIn',
};

/**
 * VIEW: OnboardingTrackerView
 * PURPOSE: One place to see whose onboarding checklist (institution,
 * position, department, contract dates, LOA document, first clock-in) is
 * still incomplete -- previously a supervisor could only discover this by
 * checking every profile individually. Supervisor-only, purely
 * client-side (analyzes already-fetched allUsers + attendance).
 */
const OnboardingTrackerView = ({ userProfile, allUsers = [], attendance = [] }) => {
    const { t } = useTranslation();
    const employeeUsers = useMemo(() => allUsers.filter((u) => u.role === 'employee'), [allUsers]);
    const entries = useMemo(() => analyzeOnboardingCompletion(employeeUsers, attendance), [employeeUsers, attendance]);

    const incompleteCount = entries.filter((e) => !e.isComplete).length;

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('onboardingTracker.supervisorOnly')}
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('onboardingTracker.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('onboardingTracker.subtitle')}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
                <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('onboardingTracker.statIncomplete')}</p>
                    <p className={`text-2xl font-black ${incompleteCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-800 dark:text-gray-100'}`}>{incompleteCount}</p>
                </div>
                <div className="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{t('onboardingTracker.statComplete')}</p>
                    <p className="text-2xl font-black text-emerald-600 dark:text-emerald-400">{entries.length - incompleteCount}</p>
                </div>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                <div className="p-5 pb-3">
                    <h2 className="text-sm font-bold text-gray-700 dark:text-gray-100 uppercase tracking-wider">{t('onboardingTracker.listTitle')}</h2>
                </div>
                {entries.length === 0 ? (
                    <p className="text-center text-xs text-gray-400 py-10 dark:text-gray-500 italic">{t('onboardingTracker.noEmployees')}</p>
                ) : (
                    <div className="divide-y divide-gray-50 dark:divide-gray-700/40">
                        {entries.map((entry) => (
                            <div key={entry.id} className="p-4">
                                <div className="flex items-center justify-between gap-4 mb-2">
                                    <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{entry.name}</p>
                                    <span className={`text-[10px] font-bold px-2 py-1 rounded-lg border shrink-0 ${
                                        entry.isComplete
                                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900/50'
                                            : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900/50'
                                    }`}>
                                        {entry.percent}%
                                    </span>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {entry.items.map((item) => (
                                        <span
                                            key={item.label}
                                            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                                                item.complete
                                                    ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/20 dark:text-emerald-400'
                                                    : 'bg-gray-100 text-gray-400 dark:bg-gray-900/40 dark:text-gray-500 line-through'
                                            }`}
                                        >
                                            {item.complete ? '✓' : '○'} {t(`onboardingTracker.${CHECKLIST_LABELS[item.label]}`)}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default OnboardingTrackerView;
