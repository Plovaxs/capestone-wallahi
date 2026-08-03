import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icons } from './Icons';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// --- MODAL COMPONENT ---
// Keyboard-accessible: Esc closes it, Tab/Shift+Tab is trapped inside while
// open, and focus returns to whatever triggered it on close.
const Modal = ({ isOpen, onClose, title, children }) => {
    const { t } = useTranslation();
    const containerRef = useRef(null);
    const triggerElementRef = useRef(null);

    useEffect(() => {
        if (!isOpen) return;

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
    }, [isOpen, onClose]);

    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex justify-center items-center">
            <div
                ref={containerRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="modal-title"
                tabIndex={-1}
                className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 dark:bg-gray-800 focus:outline-none"
            >
                <div className="flex justify-between items-center mb-4">
                    <h3 id="modal-title" className="text-xl font-bold dark:text-white">{title}</h3>
                    <button onClick={onClose} aria-label={t('common.close')} className="text-gray-400 hover:text-gray-600 dark:hover:text-white">
                        {Icons.XMark}
                    </button>
                </div>
                {/* Children will inherit dark text styles from view components */}
                {children}
            </div>
        </div>
    );
};

export default Modal;
