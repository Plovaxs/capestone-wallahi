import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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
    // 🟩 BUG FIX: most callers pass `onClose={() => setX(false)}` as a fresh
    // inline function every render. With `onClose` in the effect's
    // dependency array, ANY unrelated re-render of the caller (e.g. every
    // keystroke into a form field inside this modal, since that's a state
    // update in the parent) reran this whole effect — including the
    // "set initial focus" line — which stole focus back to the modal's
    // first focusable element (typically the × close button) on every
    // keystroke. A ref always holds the latest onClose without needing it
    // in the dependency array, so the effect (and the focus-stealing) now
    // only ever runs on an actual open/close transition.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        if (!isOpen) return;

        triggerElementRef.current = document.activeElement;
        const container = containerRef.current;
        const focusable = container?.querySelectorAll(FOCUSABLE_SELECTOR);
        (focusable?.[0] || container)?.focus();

        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                onCloseRef.current();
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
    }, [isOpen]);

    if (!isOpen) return null;

    // Portaled straight to <body> — not rendered in place. Whatever view
    // opens this Modal usually sits inside .app-content-shell, which gets a
    // CSS `filter` applied under high-contrast/colorblind mode; a `filter`
    // on an ancestor becomes the containing block for `position: fixed`
    // descendants, which would otherwise detach this overlay from the
    // viewport. Portaling to body sidesteps that regardless of call site.
    return createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex justify-center items-center p-4">
            <div
                ref={containerRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="modal-title"
                tabIndex={-1}
                className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 dark:bg-gray-800 focus:outline-none"
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
        </div>,
        document.body
    );
};

export default Modal;
