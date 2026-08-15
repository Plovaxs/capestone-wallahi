import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalDateString } from '../utils/dateOnly';
import EmptyState from '../components/EmptyState';
import { Icons } from '../components/Icons';
import ModuleTabBar from '../components/ModuleTabBar';
import { PunctualityPolicy } from '../domain/PunctualityPolicy';

const TREND_DAYS = 7;

/**
 * VIEW: TeamView ("My Team")
 * PURPOSE: Read-only visibility for a designated team lead into their
 * department's colleagues and today's attendance -- see
 * migrations/20260810_add_team_lead_hierarchy.sql for the minimal,
 * additive RLS that makes this data reach the client at all (a team lead
 * is NOT a second supervisor tier; no write/approval power is granted).
 */
const TeamView = ({ userProfile, allUsers = [], attendance = [] }) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState('overview');
    const today = getLocalDateString();

    const teammates = useMemo(
        () => allUsers.filter((u) => u.role === 'employee' && u.department === userProfile.department && u.id !== userProfile.id),
        [allUsers, userProfile]
    );

    const todaysAttendanceByEmployee = useMemo(() => {
        const map = new Map();
        attendance.forEach((a) => {
            if (a.date === today) map.set(a.employee_id, a);
        });
        return map;
    }, [attendance, today]);

    // 🟩 NEW SUBMODULE: Punctuality -- the "today only" overview above never
    // surfaced any HISTORY for teammates, even though full `attendance` is
    // already passed into this view. Reuses PunctualityPolicy (the same
    // scoring rule AttendanceView/PerformanceReviewView already share) per
    // teammate instead of inventing a new metric -- zero new backend calls.
    const punctualityByTeammate = useMemo(
        () => teammates
            .map((mate) => {
                const rows = attendance.filter((a) => a.employee_id === mate.id);
                return { id: mate.id, name: mate.name, score: PunctualityPolicy.calculate(rows), recordCount: rows.length };
            })
            .sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
        [teammates, attendance]
    );

    // 🟩 NEW SUBMODULE: Weekly Trend -- a present/late/absent grid over the
    // last TREND_DAYS calendar days per teammate, derived from the same
    // `attendance` array already in props (no new fetch).
    const trendDates = useMemo(() => {
        const dates = [];
        const cursor = new Date();
        for (let i = TREND_DAYS - 1; i >= 0; i -= 1) {
            const d = new Date(cursor);
            d.setDate(d.getDate() - i);
            dates.push(getLocalDateString(d));
        }
        return dates;
    }, []);

    const attendanceByEmployeeAndDate = useMemo(() => {
        const map = new Map();
        attendance.forEach((a) => {
            if (!map.has(a.employee_id)) map.set(a.employee_id, new Map());
            map.get(a.employee_id).set(a.date, a);
        });
        return map;
    }, [attendance]);

    const trendCellStyle = (record) => {
        if (!record) return 'bg-gray-100 dark:bg-gray-900/40 text-gray-300 dark:text-gray-600';
        if (record.status === 'Late') return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300';
        return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
    };

    if (!userProfile?.is_team_lead) {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('team.leadOnly')}
            </div>
        );
    }

    const tabs = [
        { id: 'overview', label: t('team.tabOverview'), icon: Icons.UsersGroup },
        { id: 'punctuality', label: t('team.tabPunctuality'), icon: Icons.Trophy },
        { id: 'trend', label: t('team.tabTrend'), icon: Icons.CalendarDays },
    ];

    return (
        <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('team.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('team.subtitle', { department: userProfile.department })}</p>
            </div>

            <ModuleTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'overview' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                    {teammates.length === 0 ? (
                        <EmptyState icon={Icons.UsersGroup} title={t('team.noTeammates')} />
                    ) : (
                        <div className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {teammates.map((mate) => {
                                const todayRecord = todaysAttendanceByEmployee.get(mate.id);
                                return (
                                    <div key={mate.id} className="p-4 flex items-center justify-between gap-4">
                                        <div className="min-w-0">
                                            <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{mate.name}</p>
                                            <p className="text-[10px] text-gray-400 dark:text-gray-500">{mate.position || t('dashboard.notSet')}</p>
                                        </div>
                                        <span className={`text-[10px] font-bold px-2 py-1 rounded-lg shrink-0 ${
                                            todayRecord
                                                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                                                : 'bg-gray-100 text-gray-400 dark:bg-gray-900/40 dark:text-gray-500'
                                        }`}>
                                            {todayRecord ? (todayRecord.status || t('team.clockedIn')) : t('team.notYetIn')}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'punctuality' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('team.punctualityTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('team.punctualityDescription')}</p>
                    {teammates.length === 0 ? (
                        <EmptyState icon={Icons.Trophy} title={t('team.noTeammates')} />
                    ) : (
                        <ul className="divide-y divide-gray-50 dark:divide-gray-700/40">
                            {punctualityByTeammate.map((mate) => (
                                <li key={mate.id} className="py-3 flex items-center justify-between gap-4">
                                    <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{mate.name}</span>
                                    <span className="flex items-center gap-2">
                                        {mate.score === null ? (
                                            <span className="text-[10px] text-gray-400 dark:text-gray-500">{t('team.noRecordsYet')}</span>
                                        ) : (
                                            <>
                                                <span className="text-[10px] text-gray-400 dark:text-gray-500">{t('team.recordCount', { count: mate.recordCount })}</span>
                                                <span className={`text-[10px] font-bold px-2 py-1 rounded-lg ${
                                                    mate.score >= 90
                                                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                                                        : mate.score >= 70
                                                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                                                        : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                                                }`}>
                                                    {mate.score}%
                                                </span>
                                            </>
                                        )}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {activeTab === 'trend' && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 p-6 overflow-x-auto">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('team.trendTitle')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">{t('team.trendDescription', { days: TREND_DAYS })}</p>
                    {teammates.length === 0 ? (
                        <EmptyState icon={Icons.CalendarDays} title={t('team.noTeammates')} />
                    ) : (
                        <table className="min-w-full text-[10px]">
                            <thead>
                                <tr>
                                    <th className="text-left font-bold text-gray-400 dark:text-gray-500 pb-2 pr-3">{t('team.nameColumn')}</th>
                                    {trendDates.map((date) => (
                                        <th key={date} className="font-bold text-gray-400 dark:text-gray-500 pb-2 px-1">{date.slice(5)}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {teammates.map((mate) => (
                                    <tr key={mate.id}>
                                        <td className="font-bold text-gray-700 dark:text-gray-200 pr-3 py-1 whitespace-nowrap">{mate.name}</td>
                                        {trendDates.map((date) => {
                                            const record = attendanceByEmployeeAndDate.get(mate.id)?.get(date);
                                            return (
                                                <td key={date} className="px-1 py-1">
                                                    <div className={`w-6 h-6 rounded-md flex items-center justify-center font-bold ${trendCellStyle(record)}`} title={record?.status || t('team.notYetIn')}>
                                                        {record ? (record.status === 'Late' ? 'L' : 'P') : ''}
                                                    </div>
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
};

export default TeamView;
