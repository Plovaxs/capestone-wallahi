import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalDateString } from '../utils/dateOnly';

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

    if (!userProfile?.is_team_lead) {
        return (
            <div className="p-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('team.leadOnly')}
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{t('team.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('team.subtitle', { department: userProfile.department })}</p>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700/60 overflow-hidden">
                {teammates.length === 0 ? (
                    <p className="text-center text-xs text-gray-400 py-10 dark:text-gray-500 italic">{t('team.noTeammates')}</p>
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
        </div>
    );
};

export default TeamView;
