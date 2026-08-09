import React from 'react';
import { Toaster, ToastBar, toast } from 'react-hot-toast';

/**
 * COMPONENT: AppToaster
 * PURPOSE: react-hot-toast's default toast has no way to dismiss it early
 * -- it just sits on screen until its own duration elapses (7s for error
 * toasts, see utils/errorHandling.js), which is a long wait if you've
 * already read it and want it gone. Wraps every toast (of every kind:
 * success/error/loading/custom) with an explicit "X" close button via
 * react-hot-toast's documented ToastBar render-prop pattern, applied once
 * here instead of hand-adding a dismiss button to every individual
 * toast.error()/toast.success() call site across the app.
 *
 * A single shared component (rather than repeating this customization at
 * both <Toaster> mount points -- the pre-login LoginPage shell and the
 * main authenticated app) so the two can never drift apart.
 */
const AppToaster = (props) => (
    <Toaster position="top-right" {...props}>
        {(t) => (
            <ToastBar toast={t}>
                {({ icon, message }) => (
                    <>
                        {icon}
                        {message}
                        {t.type !== 'loading' && (
                            <button
                                type="button"
                                onClick={() => toast.dismiss(t.id)}
                                aria-label="Dismiss notification"
                                className="ml-1 shrink-0 rounded-full p-1 text-current opacity-50 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 transition-opacity"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                                </svg>
                            </button>
                        )}
                    </>
                )}
            </ToastBar>
        )}
    </Toaster>
);

export default AppToaster;
