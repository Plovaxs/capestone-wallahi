import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../supabaseClient';
import { showUserError } from '../utils/errorHandling';
import { generateReviewPdf } from '../utils/generateReviewPdf';

/**
 * COMPONENT: PerformanceReviewView
 * PURPOSE: Automated University Faculty Appraisal Engine.
 * FEATURES: 
 * 1. Measures 26 points across organization, teamwork, behavior, and technical skills.
 * 2. Connects to a telemetry engine that auto-fills grades by evaluating database tracking rows.
 * ACCESS tier: Supervisors evaluate and submit reviews; Employees track personal evaluation archives.
 */
const PerformanceReviewView = ({ userProfile, allUsers = [], attendance = [], tasks = [], contributions = [] }) => {
    const { t } = useTranslation();
    // --- RUBRIC BUILDER CORE STATES ---
    const [selectedUserId, setSelectedUserId] = useState(''); // Target intern ID being reviewed
    const [scores, setScores] = useState({}); // Dictionary map tracking scores per item ID (e.g., { A1: 3, B2: 2 })
    const [comments, setComments] = useState(''); // Supervisor feedback summary text
    const [isSubmitting, setIsSubmitting] = useState(false); // Controls network submission loading indicators
    const [telemetrySummary, setTelemetrySummary] = useState(null); // Local mirror object for background activity metrics

    // --- HISTORICAL APPRAISAL STORAGE CONTROLS ---
    const [evaluations, setEvaluations] = useState([]); // Array containing loaded historic review records
    const [isLoadingHistory, setIsLoadingHistory] = useState(false); // Network fallback tracking flag for data lists
    const [editingEvalId, setEditingEvalId] = useState(null); // Populated with a row ID if amending an existing review
    const [selectedHistoricalEval, setSelectedHistoricalEval] = useState(null); // Controls read-only overlay transcripts

    // --- ROSTER SELECTION AND FILTER CONTROLS ---
    const [searchIntern, setSearchIntern] = useState('');
    const [sortOrder, setSortOrder] = useState('name-az');

    // Filter array mapping out access paths to list only intern profiles
    const employeeUsers = allUsers.filter(u => u.role === 'employee');
    const totalQuestionsCount = 26; // Total required criteria parameters inside university matrices

    // =========================================================================
    // 📋 OFFICIAL ACADEMIC COMPETENCY CRITERIA MATRIX DEFINITIONS
    // =========================================================================
    const SECTIONS = [
        {
            id: 'A',
            title: t('reviews.sectionA'),
            items: [
                { id: 'A1', text: t('reviews.A1') },
                { id: 'A2', text: t('reviews.A2') },
                { id: 'A3', text: t('reviews.A3') },
                { id: 'A4', text: t('reviews.A4') },
                { id: 'A5', text: t('reviews.A5') },
                { id: 'A6', text: t('reviews.A6') },
                { id: 'A7', text: t('reviews.A7') },
                { id: 'A8', text: t('reviews.A8') }
            ]
        },
        {
            id: 'B',
            title: t('reviews.sectionB'),
            items: [
                { id: 'B1', text: t('reviews.B1') },
                { id: 'B2', text: t('reviews.B2') },
                { id: 'B3', text: t('reviews.B3') },
                { id: 'B4', text: t('reviews.B4') },
                { id: 'B5', text: t('reviews.B5') },
                { id: 'B6', text: t('reviews.B6') },
                { id: 'B7', text: t('reviews.B7') }
            ]
        },
        {
            id: 'C',
            title: t('reviews.sectionC'),
            items: [
                { id: 'C1', text: t('reviews.C1') },
                { id: 'C2', text: t('reviews.C2') },
                { id: 'C3', text: t('reviews.C3') },
                { id: 'C4', text: t('reviews.C4') },
                { id: 'C5', text: t('reviews.C5') },
                { id: 'C6', text: t('reviews.C6') }
            ]
        },
        {
            id: 'D',
            title: t('reviews.sectionD'),
            items: [
                { id: 'D1', text: t('reviews.D1') },
                { id: 'D2', text: t('reviews.D2') },
                { id: 'D3', text: t('reviews.D3') },
                { id: 'D4', text: t('reviews.D4') },
                { id: 'D5', text: t('reviews.D5') }
            ]
        }
    ];

    const SCORE_OPTIONS = [
        { val: 1, label: t('reviews.scoreNoImprov') },
        { val: 2, label: t('reviews.scoreSomeImprov') },
        { val: 3, label: t('reviews.scoreGreatImprov') }
    ];

    // =========================================================================
    // 🔌 PLATFORM CORE QUERIES & COMPUTATION ENGINES
    // =========================================================================

    /**
     * TRANSACTION: fetchEvaluations
     * PURPOSE: Queries past evaluation records from public.performance_evaluations.
     * SECURITY: Enforces database row filters so interns can only look at their own records.
     */
    const fetchEvaluations = async () => {
        setIsLoadingHistory(true);
        // 🟩 ROBUST FIX: Pulls data safely to avoid Postgres RLS/Column crashes
        const { data, error } = await supabase.from('performance_evaluations').select('*').order('created_at', { ascending: false });
        
        if (error) {
            showUserError('Failed to load performance reviews', error);
        }
        
        let filtered = data || [];
        if (userProfile.role !== 'supervisor') {
            filtered = filtered.filter(e => e.employee_id === userProfile.id);
        }
        
        setEvaluations(filtered);
        setIsLoadingHistory(false);
    };

    useEffect(() => {
        if (userProfile) fetchEvaluations();
        // Intentional: only re-run when userProfile changes. fetchEvaluations isn't
        // memoized, so including it would refetch on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userProfile]);

    /**
     * HOOK EFFECT BACKGROUND TELEMETRY RE-EVALUATION SCANNER
     * PURPOSE: Dynamically builds performance context maps whenever an intern's ID is highlighted.
     * CALCULATIONS: 
     * - Punctuality Percentage: (Present days / Total recorded attendance days) * 100
     * - Task Bottlenecks: Scans unapproved card items where the current calendar date exceeds due deadlines
     * - Forum Engagement: Aggregates published platform threads and nested array reply counts combined
     */
    useEffect(() => {
        if (!selectedUserId) {
            setTelemetrySummary(null);
            return;
        }
        
        // 1. Calculate punctuality percentages
        const empAttendance = attendance.filter(a => a.employee_id === selectedUserId);
        const totalDays = empAttendance.length;
        const onTimeDays = empAttendance.filter(a => a.status === 'Present').length;
        const punctuality = totalDays > 0 ? Math.round((onTimeDays / totalDays) * 100) : null;

        // 2. Scan overdue task counts
        const empTasks = tasks.filter(t => (t.assigned_to || []).includes(selectedUserId));
        const todayStr = new Date().toISOString().split('T')[0];
        const overdueCount = empTasks.filter(t => !['Approved', 'Completed'].includes(t.status) && t.due_date < todayStr).length;

        // 3. Measure workspace interaction densities
        const forumActivity = contributions.filter(c => c.employee_id === selectedUserId).length;
        const commentActivity = contributions.filter(c => (c.replies || []).some(r => r.author_id === selectedUserId)).length;
        const totalForumEngagement = forumActivity + commentActivity;

        // Apply background changes into local view contexts
        setTelemetrySummary({ punctuality, overdueCount, totalForumEngagement });
    }, [selectedUserId, attendance, tasks, contributions]);

    // Esc closes the read-only transcript overlay, matching the shared Modal component's behavior.
    useEffect(() => {
        if (!selectedHistoricalEval) return;
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') setSelectedHistoricalEval(null);
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [selectedHistoricalEval]);

    /**
     * HANDLER UTILITY: handleAutoFillTelemetry
     * PURPOSE: Intelligent heuristic mapper parsing active workspace analytics 
     * directly into the grading scorecard matrix automatically.
     */
    const handleAutoFillTelemetry = () => {
        if (!telemetrySummary) return;
        
        // Establishes default 'Satisfactory / Baseline' score values (2) for all criteria spaces
        const automaticInferredScores = { ...scores };
        SECTIONS.forEach(sec => sec.items.forEach(item => { 
            if (!automaticInferredScores[item.id]) automaticInferredScores[item.id] = 2; 
        }));

        // CRITERIA A1 ALGORITHM: Sets maximum points if overdue items equal 0; drops points if backlogs mount
        if (telemetrySummary.overdueCount === 0) automaticInferredScores['A1'] = 3;
        else if (telemetrySummary.overdueCount > 2) automaticInferredScores['A1'] = 1;

        // CRITERIA A7 ALGORITHM: Automatically scores punctuality boundaries based on recorded percentages
        if (telemetrySummary.punctuality !== null) {
            if (telemetrySummary.punctuality >= 90) automaticInferredScores['A7'] = 3;
            else if (telemetrySummary.punctuality < 75) automaticInferredScores['A7'] = 1;
        }

        // CRITERIA B6 & B7 ALGORITHMS: Awards top interaction marks if forum discussions pass threshold barriers
        if (telemetrySummary.totalForumEngagement >= 5) {
            automaticInferredScores['B6'] = 3;
            automaticInferredScores['B7'] = 3;
        }
        setScores(automaticInferredScores);
    };

    const handleSelectScore = (itemId, rating) => {
        setScores(prev => ({ ...prev, [itemId]: rating }));
    };

    /**
     * CALCULATOR FUNCTION: calculateFinalScores
     * PURPOSE: Math parsing engine processing rubric points to generate the final index.
     * FORMULA: (Sum of selected item score choices / Maximum possible raw row point bounds) * 100
     * ACCREDITATION INDEX PROFILE boundaries:
     * - Score >= 60.00 -> Grade A (Average / Satisfactory Institutional Requirement)
     * - Score >= 50.00 -> Grade NI (Needs Improvement in under-performing sectors)
     * - Score < 50.00  -> Grade P (Poor / Unsatisfactory Compliance standard limits)
     */
    const calculateFinalScores = () => {
        const answeredCount = Object.keys(scores).length;
        if (answeredCount === 0) return { pointTotal: 0, rubric: { grade: 'P', style: 'text-red-500 bg-red-950/20', desc: t('reviews.descNone') } };

        const rawSum = Object.values(scores).reduce((sum, val) => sum + val, 0);
        const maxPossibleRaw = totalQuestionsCount * 3; // 26 items * 3 max points each
        const pointTotal = parseFloat(((rawSum / maxPossibleRaw) * 100).toFixed(2));

        let rubric = { grade: t('reviews.gradeP'), style: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300 border-red-200 dark:border-red-900', desc: t('reviews.descPoor') };
        if (pointTotal >= 60.00) {
            rubric = { grade: t('reviews.gradeA'), style: 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300 border-green-200 dark:border-green-900', desc: t('reviews.descAverage') };
        } else if (pointTotal >= 50.00) {
            rubric = { grade: t('reviews.gradeNI'), style: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border-amber-200 dark:border-amber-900', desc: t('reviews.descNeedsImprovement') };
        }
        return { pointTotal, rubric };
    };

    const { pointTotal, rubric } = calculateFinalScores();
    const totalAnsweredQuestions = Object.keys(scores).length;

    // --- MUTATION HANDLING ENDPOINTS (DB DISPATCH CHANNELS) ---
    const handleSubmitEvaluation = async () => {
        if (!selectedUserId) return alert(t('reviews.selectStaffFirst'));
        if (totalAnsweredQuestions < totalQuestionsCount) {
            return alert(t('reviews.incompleteRubric', { count: totalQuestionsCount - totalAnsweredQuestions }));
        }

        setIsSubmitting(true);
       if (editingEvalId) {
            const { error } = await supabase.from('performance_evaluations').update({ scores, final_score: pointTotal, comments }).eq('id', editingEvalId);
            if (error) showUserError('Failed to update review', error);
            else {
                alert(t('reviews.appraisalUpdated'));
                // Notifying the employee is now handled server-side by the
                // notify_evaluation trigger — the client can no longer
                // insert into notifications directly (RLS).
                resetForm();
                fetchEvaluations();
            }
        } else {
            const { error } = await supabase.from('performance_evaluations').insert({
                employee_id: selectedUserId, supervisor_id: userProfile.id, scores, final_score: pointTotal, comments
            });
            if (error) showUserError('Failed to submit review', error);
            else {
                alert(t('reviews.appraisalSubmitted'));
                // Notifying the employee is now handled server-side by the
                // notify_evaluation trigger — the client can no longer
                // insert into notifications directly (RLS).
                resetForm();
                fetchEvaluations();
            }
        }
        setIsSubmitting(false);
    };

    const handleEditLoad = (evaluation) => {
        setSelectedUserId(evaluation.employee_id);
        setScores(evaluation.scores || {});
        setComments(evaluation.comments || '');
        setEditingEvalId(evaluation.id);
        setSelectedHistoricalEval(null);
    };

    const handleDeleteEvaluation = async (id) => {
        if (!confirm(t('reviews.confirmDeleteRecord'))) return;
        const { error } = await supabase.from('performance_evaluations').delete().eq('id', id);
        if (error) showUserError('Failed to delete review', error);
        else {
            alert(t('reviews.recordDeleted'));
            fetchEvaluations();
        }
    };

    const resetForm = () => {
        setSelectedUserId('');
        setScores({});
        setComments('');
        setEditingEvalId(null);
    };

    const getUserName = (id) => allUsers.find(u => u.id === id)?.name || t('reviews.unknownUser');

    const handleDownloadPdf = (evaluation) => {
        generateReviewPdf({
            evaluation,
            sections: SECTIONS,
            scoreOptions: SCORE_OPTIONS,
            employeeName: getUserName(evaluation.employee_id),
            supervisorName: getUserName(evaluation.supervisor_id),
            labels: {
                reportTitle: t('reviews.pdfReportTitle'),
                reportSubtitle: t('reviews.pdfReportSubtitle'),
                employee: t('reviews.pdfEmployee'),
                supervisor: t('reviews.pdfSupervisor'),
                issuedOn: t('reviews.pdfIssuedOn'),
                finalScore: t('reviews.pdfFinalScore'),
                unmarked: t('reviews.unmarked'),
                remarks: t('reviews.pdfRemarks'),
                noRemarks: t('reviews.pdfNoRemarks'),
                generatedOn: t('reviews.pdfGeneratedOn', { date: new Date().toLocaleString() }),
                filenamePrefix: t('reviews.pdfFilenamePrefix'),
            },
        });
    };

    // Roster sorter and search parsing filter pipeline
    const processedRoster = employeeUsers
        .filter(emp => emp.name.toLowerCase().includes(searchIntern.toLowerCase()))
        .sort((a, b) => {
            if (sortOrder === 'name-az') return a.name.localeCompare(b.name);
            if (sortOrder === 'name-za') return b.name.localeCompare(a.name);
            if (sortOrder === 'campus') {
                const srcA = a.source || a.university || '';
                const srcB = b.source || b.university || '';
                return srcA.localeCompare(srcB);
            }
            return 0;
        });

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-6">
            <div>
                <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">{t('reviews.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('reviews.subtitle')}</p>
            </div>

            {/* SUPERVISOR PANEL INTERFACE SHEETS */}
            {userProfile.role === 'supervisor' && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    
                    {/* SIDEBAR NAVIGATION LIST ROSTER */}
                    <div className="space-y-4">
                        <div className="bg-white dark:bg-gray-800 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 space-y-3">
                            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">{t('reviews.activeRoster')}</h3>
                            <div className="space-y-2">
                                <input
                                    type="text"
                                    value={searchIntern}
                                    onChange={(e) => setSearchIntern(e.target.value)}
                                    placeholder={t('reviews.searchStaffPlaceholder')}
                                    className="w-full p-2 text-[11px] border border-gray-100 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none"
                                />
                                <select
                                    value={sortOrder}
                                    onChange={(e) => setSortOrder(e.target.value)}
                                    className="w-full p-2 text-[11px] border border-gray-100 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-900 dark:text-white focus:outline-none"
                                >
                                    <option value="name-az">{t('reviews.sortAZ')}</option>
                                    <option value="name-za">{t('reviews.sortZA')}</option>
                                    <option value="campus">{t('reviews.sortByInstitution')}</option>
                                </select>
                            </div>

                            <div className="space-y-1.5 max-h-48 overflow-y-auto pt-2">
                                {processedRoster.map(emp => (
                                    <button
                                        key={emp.id}
                                        type="button"
                                        onClick={() => { setSelectedUserId(emp.id); setScores({}); setEditingEvalId(null); }}
                                        className={`w-full text-left p-3 rounded-xl font-bold text-xs border transition-all flex items-center justify-between ${
                                            selectedUserId === emp.id
                                                ? 'bg-blue-600 border-blue-600 text-white shadow-md'
                                                : 'bg-gray-50 hover:bg-gray-100 border-gray-50 dark:bg-gray-900/40 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700'
                                        }`}
                                    >
                                        <span>{emp.name}</span>
                                        <span className={`text-[9px] px-2 py-0.5 rounded-lg border uppercase ${selectedUserId === emp.id ? 'bg-white/20 border-white/10' : 'bg-gray-200/60 text-gray-400 dark:bg-gray-800'}`}>
                                            {emp.source?.split(' ')[0] || t('reviews.staffBadge')}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* LIVE METRICS SYNC DISPLAY SHEET WIDGET */}
                        {telemetrySummary && (
                            <div className="bg-white dark:bg-gray-800 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 space-y-3 animate-fade-in">
                                <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">{t('reviews.liveTelemetry')}</h3>
                                <div className="space-y-2 text-[11px] font-bold">
                                    <div className="p-2.5 bg-gray-50 dark:bg-gray-900 rounded-xl flex justify-between">
                                        <span className="text-gray-400">{t('reviews.punctualityScore')}</span>
                                        <span className="text-gray-700 dark:text-gray-200">{telemetrySummary.punctuality !== null ? `${telemetrySummary.punctuality}%` : 'N/A'}</span>
                                    </div>
                                    <div className="p-2.5 bg-gray-50 dark:bg-gray-900 rounded-xl flex justify-between">
                                        <span className="text-gray-400">{t('reviews.overdueTasks')}</span>
                                        <span className={telemetrySummary.overdueCount > 0 ? "text-red-500" : "text-green-500"}>{telemetrySummary.overdueCount} {t('reviews.items')}</span>
                                    </div>
                                    <div className="p-2.5 bg-gray-50 dark:bg-gray-900 rounded-xl flex justify-between">
                                        <span className="text-gray-400">{t('reviews.forumInteractions')}</span>
                                        <span className="text-gray-700 dark:text-gray-200">{telemetrySummary.totalForumEngagement} {t('reviews.activity')}</span>
                                    </div>
                                </div>
                                <button type="button" onClick={handleAutoFillTelemetry} className="w-full bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-900 py-2.5 rounded-xl text-xs font-bold transition shadow-sm">
                                    {t('reviews.autoAnalyze')}
                                </button>
                            </div>
                        )}
                    </div>

                    {/* MAIN RUBRIC INTERACTIVE SHEET LIST */}
                    <div className="lg:col-span-2 space-y-4">
                        {selectedUserId ? (
                            <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm overflow-hidden flex flex-col">
                                
                                {/* STICKY SCORING HEADER STATS PANEL */}
                                <div className="p-5 border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 flex justify-between items-center sticky top-0 z-10 backdrop-blur">
                                    <div>
                                        <h2 className="font-bold text-sm text-gray-800 dark:text-white">
                                            {editingEvalId ? t('reviews.amendingReview') : t('reviews.gradingRubric')} {getUserName(selectedUserId)}
                                        </h2>
                                        <p className="text-[10px] text-gray-400 font-bold uppercase mt-0.5">
                                            {t('reviews.completedFields', { answered: totalAnsweredQuestions, total: totalQuestionsCount })}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <div className={`p-2 rounded-xl border text-[10px] font-bold leading-tight ${rubric.style}`}>
                                            {t('reviews.index')} <b className="text-xs font-black">{pointTotal}</b> | {rubric.grade.split(' ')[0]}
                                        </div>
                                        {editingEvalId && <button onClick={resetForm} className="bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:text-white text-[10px] font-bold px-2.5 py-2 rounded-lg transition">{t('reviews.cancel')}</button>}
                                    </div>
                                </div>

                                {/* SCROLLABLE RUBRIC CRITERIA CONTAINER LIST */}
                                <div className="p-5 space-y-8 max-h-[500px] overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700/60">
                                    {SECTIONS.map(section => (
                                        <div key={section.id} className="pt-6 first:pt-0 space-y-4">
                                            <h3 className="font-bold text-xs text-blue-600 dark:text-blue-400 uppercase tracking-wide border-b dark:border-gray-700 pb-1.5">{section.title}</h3>
                                            <div className="space-y-3">
                                                {section.items.map((item, index) => (
                                                    <div key={item.id} className="p-3.5 border border-gray-50 dark:border-gray-700/40 bg-gray-50/20 dark:bg-gray-900/20 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3 hover:bg-gray-50/50 transition-all">
                                                        <div className="flex gap-2 text-xs text-gray-700 dark:text-gray-300 leading-normal flex-1">
                                                            <span className="font-mono font-bold text-gray-400">{index + 1}.</span>
                                                            <p>{item.text}</p>
                                                        </div>

                                                        {/* SCORE RADIO PILL TRIGGER SWITCHES */}
                                                        <div className="flex bg-gray-100 dark:bg-gray-900 p-1 rounded-xl self-end md:self-center shrink-0 border dark:border-gray-700 gap-1">
                                                            {SCORE_OPTIONS.map(opt => {
                                                                const isSelected = scores[item.id] === opt.val;
                                                                return (
                                                                    <button
                                                                        key={opt.val}
                                                                        type="button"
                                                                        onClick={() => handleSelectScore(item.id, opt.val)}
                                                                        className={`px-3 py-1.5 text-[10px] font-extrabold rounded-lg transition-all ${
                                                                            isSelected 
                                                                                ? 'bg-blue-600 text-white shadow-sm' 
                                                                                : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'
                                                                        }`}
                                                                    >
                                                                        {opt.label}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ))}

                                    {/* CONCLUDING REMARKS FEEDBACK TEXT AREA */}
                                    <div className="pt-6">
                                        <label htmlFor="review-comments" className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">{t('reviews.concludingFeedback')}</label>
                                        <textarea
                                            id="review-comments"
                                            value={comments}
                                            onChange={e => setComments(e.target.value)}
                                            className="w-full p-4 border border-gray-100 dark:border-gray-600 text-xs rounded-xl bg-gray-50/50 dark:bg-gray-900 dark:text-white resize-none focus:outline-none"
                                            placeholder={t('reviews.concludingPlaceholder')}
                                            rows="2"
                                        ></textarea>
                                    </div>
                                </div>

                                {/* BASE FORUM CONTROLS SUBMIT DISPATCH ROW */}
                                <div className="p-4 border-t border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 flex justify-between items-center">
                                    <span className="text-[10px] text-gray-400 italic max-w-xs leading-tight">{rubric.desc}</span>
                                    <button
                                        type="button"
                                        onClick={handleSubmitEvaluation}
                                        disabled={isSubmitting || totalAnsweredQuestions < totalQuestionsCount}
                                        className={`px-5 py-2 rounded-xl text-xs font-bold text-white shadow transition-all ${
                                            totalAnsweredQuestions < totalQuestionsCount ? 'bg-gray-300 dark:bg-gray-700 cursor-not-allowed text-gray-500' : 'bg-blue-600 hover:bg-blue-700'
                                        }`}
                                    >
                                        {isSubmitting ? t('reviews.saving') : (editingEvalId ? t('reviews.updateAppraisal') : t('reviews.submitScorecard'))}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="bg-gray-50 border border-dashed border-gray-200 rounded-2xl h-64 flex flex-col justify-center items-center text-center p-6 text-gray-400 dark:bg-gray-800 dark:border-gray-700">
                                <span className="text-2xl mb-1">📋</span>
                                <h4 className="font-bold text-xs text-gray-700 dark:text-gray-300">{t('reviews.noStaffSelected')}</h4>
                                <p className="text-[11px] max-w-xs leading-normal mt-0.5">{t('reviews.selectFromRoster')}</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* --- HISTORICAL APPRAISAL DATA TABLES ARCHIVE LEDGER --- */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
                <div className="p-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-700/30">
                    <h2 className="text-sm font-bold text-gray-800 dark:text-gray-100">
                        {userProfile.role === 'supervisor' ? t('reviews.historicalLogs') : t('reviews.myAppraisals')}
                    </h2>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead className="bg-gray-50/80 dark:bg-gray-700/40 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                            <tr>
                                <th className="p-4">{t('reviews.colDateIssued')}</th>
                                <th className="p-4">{t('reviews.colStaffName')}</th>
                                <th className="p-4">{t('reviews.colAccreditedIndex')}</th>
                                <th className="p-4">{t('reviews.colRemarksSummary')}</th>
                                <th className="p-4 text-right">{t('reviews.colActions')}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700 text-xs">
                            {evaluations.map(record => (
                                <tr key={record.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-700/20 transition-all">
                                    <td className="p-4 font-mono font-bold text-gray-500">{new Date(record.created_at).toLocaleDateString('en-GB')}</td>
                                    <td className="p-4 font-bold text-gray-800 dark:text-gray-200">{getUserName(record.employee_id)}</td>
                                    <td className="p-4">
                                        <span className={`px-2 py-0.5 font-bold rounded-lg ${
                                            record.final_score >= 60 ? 'bg-green-50 text-green-700 dark:bg-green-950/30' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30'
                                        }`}>
                                            {t('reviews.index')} {record.final_score}
                                        </span>
                                    </td>
                                    <td className="p-4 text-gray-500 max-w-xs truncate italic">"{record.comments || t('reviews.noWrittenRemarks')}"</td>
                                    <td className="p-4 text-right">
                                        <div className="inline-flex gap-2 justify-end">
                                            <button onClick={() => setSelectedHistoricalEval(record)} className="text-blue-600 bg-blue-50 px-2 py-1 rounded-md font-bold text-[10px] dark:bg-blue-900/30 dark:text-blue-300">{t('reviews.fullRubricReport')}</button>
                                            <button onClick={() => handleDownloadPdf(record)} className="text-indigo-600 bg-indigo-50 px-2 py-1 rounded-md font-bold text-[10px] dark:bg-indigo-900/30 dark:text-indigo-300">{t('reviews.downloadPdf')}</button>
                                            {userProfile.role === 'supervisor' && (
                                                <>
                                                    <button onClick={() => handleEditLoad(record)} className="text-amber-600 bg-amber-50 px-2 py-1 rounded-md font-bold text-[10px] dark:bg-amber-900/30 dark:text-amber-300">{t('reviews.edit')}</button>
                                                    <button onClick={() => handleDeleteEvaluation(record.id)} className="text-red-600 bg-red-50 px-2 py-1 rounded-md font-bold text-[10px] dark:bg-red-900/30 dark:text-red-300">{t('reviews.delete')}</button>
                                                </>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {evaluations.length === 0 && !isLoadingHistory && (
                                <tr>
                                    <td colSpan="5" className="p-8 text-center text-xs text-gray-400 italic">{t('reviews.noEvaluations')}</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* ========================================================================= */}
            {/* POPUP FULL READ-ONLY MODAL OVERLAY (FIXED INTERN DISPLAY TRANSCRIPTS)    */}
            {/* ========================================================================= */}
            {selectedHistoricalEval && (
                <div
                    className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 flex justify-center items-center p-4"
                    onClick={() => setSelectedHistoricalEval(null)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="transcript-modal-title"
                        className="bg-white dark:bg-gray-800 w-full max-w-5xl rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-700 flex flex-col max-h-[85vh] overflow-hidden animate-scale-up"
                        onClick={(e) => e.stopPropagation()}
                    >
                        
                        {/* STICKY TRANSCRIPT HEADER */}
                        <div className="p-4 border-b border-gray-100 dark:border-gray-700 flex justify-between items-center bg-gray-50 dark:bg-gray-900/40 shrink-0">
                            <div>
                                <h3 id="transcript-modal-title" className="font-bold text-sm dark:text-white">{t('reviews.fullTranscriptSummary')}</h3>
                                <p className="text-[10px] text-gray-400 font-bold font-mono uppercase mt-0.5">
                                    {t('reviews.assessedEmployee', { name: getUserName(selectedHistoricalEval.employee_id) })}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setSelectedHistoricalEval(null)}
                                aria-label={t('common.close')}
                                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm font-black p-1 transition-colors"
                            >
                                ✕
                            </button>
                        </div>
                        
                        {/* SCROLLABLE TRANSCRIPT DOUBLE GRID BODY PANEL */}
                        <div className="p-6 overflow-y-auto flex-1 min-h-0 space-y-6 text-xs">
                            
                            {/* Score Index Banner metrics */}
                            <div className="grid grid-cols-2 gap-4 bg-gray-50 dark:bg-gray-900 p-4 rounded-xl border border-gray-100 dark:border-gray-700">
                                <div>
                                    <span className="text-gray-400 block font-normal text-[11px]">{t('reviews.finalIndexScore')}</span>
                                    <b className="text-base text-blue-600 dark:text-blue-400 block mt-1">{selectedHistoricalEval.final_score} {t('reviews.points')}</b>
                                </div>
                                <div>
                                    <span className="text-gray-400 block font-normal text-[11px]">{t('reviews.issuanceTimestamp')}</span>
                                    <b className="text-sm text-gray-800 dark:text-gray-100 block mt-1 font-mono">
                                        {new Date(selectedHistoricalEval.created_at).toLocaleString('en-GB')}
                                    </b>
                                </div>
                            </div>

                            {/* Section breakdown lists */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                                {SECTIONS.map(sec => (
                                    <div key={sec.id} className="space-y-3 bg-gray-50/30 dark:bg-gray-900/10 p-4 rounded-xl border border-gray-100/70 dark:border-gray-700/50">
                                        <h4 className="font-bold text-blue-600 dark:text-blue-400 tracking-wide uppercase text-[11px] pb-1 border-b border-gray-100 dark:border-gray-700">
                                            {sec.title}
                                        </h4>
                                        <div className="space-y-2">
                                            {sec.items.map((item, idx) => {
                                                const scoreValue = selectedHistoricalEval.scores?.[item.id] || '--';
                                                const matchedLabel = SCORE_OPTIONS.find(o => o.val === scoreValue)?.label || t('reviews.unmarked');
                                                
                                                return (
                                                    <div key={item.id} className="flex justify-between items-start py-1.5 border-b border-gray-50 dark:border-gray-800/40 gap-4 last:border-none">
                                                        <span className="text-gray-600 dark:text-gray-300 pr-2">
                                                            {idx + 1}. {item.text}
                                                        </span>
                                                        <span className="font-mono bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 rounded text-blue-600 dark:text-blue-400 shrink-0 text-[10px] font-bold h-fit align-middle">
                                                            {matchedLabel}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Concluding comments summary */}
                            <div className="pt-4 border-t border-gray-100 dark:border-gray-700">
                                <h4 className="font-bold text-gray-400 uppercase tracking-wider text-[10px] mb-1">{t('reviews.finalRemarks')}</h4>
                                <p className="p-3 bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-700 rounded-xl italic text-gray-700 dark:text-gray-300">
                                    "{selectedHistoricalEval.comments || t('reviews.noWrittenSummary')}"
                                </p>
                            </div>
                        </div>

                        {/* Transcript overlay control line */}
                        <div className="p-3 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 flex justify-end gap-2 shrink-0">
                            <button
                                type="button"
                                onClick={() => handleDownloadPdf(selectedHistoricalEval)}
                                className="bg-indigo-600 text-white hover:bg-indigo-700 px-5 py-2 font-bold rounded-xl text-xs transition shadow-sm"
                            >
                                {t('reviews.downloadPdf')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setSelectedHistoricalEval(null)}
                                className="bg-gray-800 text-white hover:bg-gray-900 px-5 py-2 font-bold rounded-xl text-xs dark:bg-blue-600 dark:hover:bg-blue-700 transition shadow-sm"
                            >
                                {t('reviews.closeTranscript')}
                            </button>
                        </div>

                    </div>
                </div>
            )}
        </div>
    );
};

export default PerformanceReviewView;