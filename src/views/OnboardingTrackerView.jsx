import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { analyzeOnboardingCompletion } from '../domain/onboardingCompletionTracker';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';
import ModuleTabBar from '../components/ModuleTabBar';

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
    const [activeTab, setActiveTab] = useState('overview');
    const employeeUsers = useMemo(() => allUsers.filter((u) => u.role === 'employee'), [allUsers]);
    const entries = useMemo(() => analyzeOnboardingCompletion(employeeUsers, attendance), [employeeUsers, attendance]);

    const incompleteCount = entries.filter((e) => !e.isComplete).length;

    // 🟩 NEW SUBMODULE: By Checklist Item -- the overview list only shows
    // completion PER EMPLOYEE; this aggregates the exact same `entries`
    // the other way (per checklist item across everyone) to answer "which
    // single onboarding step is the actual bottleneck" -- e.g. if everyone
    // is missing their LOA document specifically, that's a process fix,
    // not an individual-employee follow-up. Zero new computation beyond
    // what analyzeOnboardingCompletion already returns.
    const itemStats = useMemo(() => {
        if (entries.length === 0) return [];
        const labels = Object.keys(CHECKLIST_LABELS);
        return labels.map((label) => {
            const completeCount = entries.filter((e) => e.items.find((i) => i.label === label)?.complete).length;
            return { label, completeCount, percent: Math.round((completeCount / entries.length) * 100) };
        }).sort((a, b) => a.percent - b.percent);
    }, [entries]);

    // 🟩 NEW SUBMODULE: By Department -- average onboarding completion %
    // grouped by department, reusing the `department` field every
    // employee already has. Surfaces whether incomplete onboarding is
    // spread evenly or concentrated in one department's intake process.
    const departmentStats = useMemo(() => {
        const byDept = new Map();
        employeeUsers.forEach((emp) => {
            const entry = entries.find((e) => e.id === emp.id);
            if (!entry) return;
            const dept = emp.department || t('dashboard.notSet');
            if (!byDept.has(dept)) byDept.set(dept, []);
            byDept.get(dept).push(entry.percent);
        });
        return Array.from(byDept.entries())
            .map(([department, percents]) => ({
                department,
                avgPercent: Math.round(percents.reduce((a, b) => a + b, 0) / percents.length),
                count: percents.length,
            }))
            .sort((a, b) => a.avgPercent - b.avgPercent);
    }, [employeeUsers, entries, t]);

    if (userProfile?.role !== 'supervisor') {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('onboardingTracker.supervisorOnly')}
            </div>
        );
    }

    const tabs = [
        { id: 'overview', label: t('onboardingTracker.tabOverview'), icon: Icons.ListChecks },
        { id: 'byItem', label: t('onboardingTracker.tabByItem'), icon: Icons.ClipboardCheck },
        { id: 'byDepartment', label: t('onboardingTracker.tabByDepartment'), icon: Icons.UsersGroup },
    ];

    return (
        <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('onboardingTracker.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('onboardingTracker.subtitle')}</p>
            </div>

            <ModuleTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'overview' && (
                <>
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
                            <EmptyState icon={Icons.ListChecks} title={t('onboardingTracker.noEmployees')} />
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
                </>
            )}

            {activeTab === 'byItem' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('onboardingTracker.byItemTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('onboardingTracker.byItemDescription')}</p>
                    {itemStats.length === 0 ? (
                        <EmptyState icon={Icons.ClipboardCheck} title={t('onboardingTracker.noEmployees')} />
                    ) : (
                        <ul className="space-y-3">
                            {itemStats.map((item) => (
                                <li key={item.label}>
                                    <div className="flex items-center justify-between gap-4 mb-1 text-xs">
                                        <span className="font-bold text-gray-700 dark:text-gray-200">{t(`onboardingTracker.${CHECKLIST_LABELS[item.label]}`)}</span>
                                        <span className="text-gray-400 dark:text-gray-500">{t('onboardingTracker.itemCompleteCount', { count: item.completeCount, total: entries.length })}</span>
                                    </div>
                                    <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-900/40 overflow-hidden">
                                        <div
                                            className={`h-full rounded-full ${item.percent === 100 ? 'bg-emerald-500' : item.percent >= 50 ? 'bg-amber-500' : 'bg-red-500'}`}
                                            style={{ width: `${item.percent}%` }}
                                        />
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {activeTab === 'byDepartment' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('onboardingTracker.byDepartmentTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('onboardingTracker.byDepartmentDescription')}</p>
                    {departmentStats.length === 0 ? (
                        <EmptyState icon={Icons.UsersGroup} title={t('onboardingTracker.noEmployees')} />
                    ) : (
                        <ul className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {departmentStats.map((row) => (
                                <li key={row.department} className="py-3 flex items-center justify-between gap-4">
                                    <div>
                                        <p className="text-xs font-bold text-gray-700 dark:text-gray-200">{row.department}</p>
                                        <p className="text-[10px] text-gray-400 dark:text-gray-500">{t('onboardingTracker.employeeCount', { count: row.count })}</p>
                                    </div>
                                    <span className={`text-[10px] font-bold px-2 py-1 rounded-lg shrink-0 ${
                                        row.avgPercent === 100
                                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                                            : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                                    }`}>
                                        {row.avgPercent}%
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
};

export default OnboardingTrackerView;
