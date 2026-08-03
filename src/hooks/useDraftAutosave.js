import { useEffect, useRef } from 'react';

const DEBOUNCE_MS = 500;

const isDraftEmpty = (draft) =>
    Object.values(draft).every(
        (v) => v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0)
    );

/**
 * Autosaves `draft` (a plain object of form field values) to localStorage under `key`,
 * debounced so it doesn't write on every keystroke. Clears the stored draft once all
 * fields go back to empty (e.g. after a successful submit resets local state).
 */
export function useDraftAutosave(key, draft, { enabled = true } = {}) {
    const timeoutRef = useRef(null);

    useEffect(() => {
        if (!enabled || !key) return;
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => {
            try {
                if (isDraftEmpty(draft)) {
                    localStorage.removeItem(key);
                } else {
                    localStorage.setItem(key, JSON.stringify(draft));
                }
            } catch {
                // localStorage unavailable (private browsing, quota) — skip silently
            }
        }, DEBOUNCE_MS);
        return () => clearTimeout(timeoutRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, JSON.stringify(draft), enabled]);
}

export function loadDraft(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function clearDraft(key) {
    try {
        localStorage.removeItem(key);
    } catch {
        // ignore
    }
}
