import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { registerConfirmHandler } from '../utils/confirm';

/**
 * COMPONENT: ConfirmDialogHost
 * PURPOSE: Single mounted instance (see App.jsx) that answers every
 * confirmDialog(...) call app-wide with an accessible modal (reuses the
 * shared Modal component: focus trap, Esc-to-close, aria-modal) instead of
 * the browser's blocking window.confirm().
 */
const ConfirmDialogHost = () => {
    const { t } = useTranslation();
    const [state, setState] = useState(null); // { message, resolve, variant, confirmLabel, cancelLabel }

    const show = useCallback((message, options = {}) => {
        return new Promise((resolve) => {
            setState({ message, resolve, ...options });
        });
    }, []);

    useEffect(() => {
        registerConfirmHandler(show);
    }, [show]);

    const respond = (value) => {
        state?.resolve(value);
        setState(null);
    };

    const isDanger = state?.variant === 'danger';

    return (
        <Modal isOpen={!!state} onClose={() => respond(false)} title={state?.title || t('confirm.defaultTitle')}>
            <div className="space-y-4">
                <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-line">{state?.message}</p>
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={() => respond(false)}
                        className="px-4 py-2 text-xs font-bold rounded-xl border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                        {state?.cancelLabel || t('confirm.cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={() => respond(true)}
                        className={`px-4 py-2 text-xs font-bold rounded-xl text-white shadow-sm ${isDanger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                    >
                        {state?.confirmLabel || t('confirm.confirm')}
                    </button>
                </div>
            </div>
        </Modal>
    );
};

export default ConfirmDialogHost;
