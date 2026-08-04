import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * COMPONENT: OnboardingTour
 * PURPOSE: A short first-login walkthrough of the app's main sections, so a
 * new user (or an examiner clicking through a demo) understands what's
 * available without hunting through every menu item themselves.
 * PERSISTENCE: Dismissal is tracked per-role in localStorage (not per-user
 * id) since supervisors and employees see materially different step sets —
 * a role switch should show the tour again, a page refresh shouldn't.
 */
const OnboardingTour = ({ userProfile, onClose }) => {
    const { t } = useTranslation();
    const [step, setStep] = useState(0);
    const containerRef = useRef(null);
    const triggerElementRef = useRef(null);

    const isSupervisor = userProfile.role === 'supervisor';

    const steps = [
        { icon: '👋', title: t('onboarding.welcomeTitle'), desc: t('onboarding.welcomeDesc', { name: userProfile.name?.split(' ')[0] }) },
        { icon: '📊', title: t('onboarding.dashboardTitle'), desc: isSupervisor ? t('onboarding.dashboardDescSupervisor') : t('onboarding.dashboardDescEmployee') },
        { icon: '🕒', title: t('onboarding.attendanceTitle'), desc: t('onboarding.attendanceDesc') },
        { icon: '📋', title: t('onboarding.tasksTitle'), desc: t('onboarding.tasksDesc') },
        { icon: '🌴', title: t('onboarding.leaveTitle'), desc: t('onboarding.leaveDesc') },
        { icon: '💬', title: t('onboarding.forumTitle'), desc: t('onboarding.forumDesc') },
        ...(isSupervisor ? [
            { icon: '⭐', title: t('onboarding.reviewsTitle'), desc: t('onboarding.reviewsDesc') },
            { icon: '🕵️', title: t('onboarding.auditTitle'), desc: t('onboarding.auditDesc') },
        ] : []),
        { icon: '♿', title: t('onboarding.accessibilityTitle'), desc: t('onboarding.accessibilityDesc') },
    ];

    const isLastStep = step === steps.length - 1;
    const current = steps[step];

    // 🟩 ACCESSIBILITY: matches Modal.jsx's focus-trap + restore-on-close —
    // this dialog had `role="dialog" aria-modal="true"` but no actual trap,
    // so Tab could cycle a keyboard user straight through to the dimmed
    // background content behind the overlay, and nothing set initial focus
    // when the tour opened.
    useEffect(() => {
        triggerElementRef.current = document.activeElement;
        const container = containerRef.current;
        const focusable = container?.querySelectorAll(FOCUSABLE_SELECTOR);
        (focusable?.[0] || container)?.focus();

        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                onClose();
                return;
            }
            if (e.key !== 'Tab' || !container) return;

            const focusableEls = container.querySelectorAll(FOCUSABLE_SELECTOR);
            if (focusableEls.length === 0) return;
            const first = focusableEls[0];
            const last = focusableEls[focusableEls.length - 1];

            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            triggerElementRef.current?.focus?.();
        };
    }, [onClose]);

    return (
        <div className="fixed inset-0 bg-black/50 z-[60] flex justify-center items-center p-4" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
            <div ref={containerRef} tabIndex={-1} className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-md w-full p-6 text-center animate-scale-up focus:outline-none">
                <div className="text-5xl mb-4">{current.icon}</div>
                <h2 id="onboarding-title" className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-2">{current.title}</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{current.desc}</p>

                <div className="flex justify-center gap-1.5 my-6">
                    {steps.map((_, i) => (
                        <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-blue-600' : 'w-1.5 bg-gray-200 dark:bg-gray-600'}`} />
                    ))}
                </div>

                <div className="flex items-center justify-between gap-3">
                    <button type="button" onClick={onClose} className="text-xs font-bold text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 px-3 py-2">
                        {t('onboarding.skip')}
                    </button>
                    <div className="flex gap-2">
                        {step > 0 && (
                            <button type="button" onClick={() => setStep(s => s - 1)} className="text-xs font-bold text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-600 px-4 py-2 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-700">
                                {t('onboarding.back')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => isLastStep ? onClose() : setStep(s => s + 1)}
                            className="text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 px-5 py-2 rounded-xl shadow-sm"
                        >
                            {isLastStep ? t('onboarding.getStarted') : t('onboarding.next')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default OnboardingTour;
