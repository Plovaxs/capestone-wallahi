import toast from 'react-hot-toast';
import i18n from '../i18n';
import { reportClientError } from '../monitoring/errorReporter';

/**
 * Logs the real error for debugging and shows the user a generic,
 * non-leaking message instead of raw Postgres/PostgREST error text
 * (which can expose table/column/constraint names to any authenticated
 * user probing the app). Uses the i18n instance directly (not the
 * useTranslation hook) since this is a plain utility, not a component.
 *
 * 🟩 CLARITY FIX: `context` used to be a raw, hardcoded English string
 * ("Failed to record attendance") shown as-is regardless of the app's
 * current language -- an Indonesian-speaking user on the ID locale would
 * see a half-English, half-Indonesian error, which is exactly the kind of
 * confusing, hard-to-troubleshoot message a non-technical user (or, per
 * the person who asked for this fix, "not every lecturer is tech-savvy")
 * gets stuck on. `context` is now an i18n key under `errors.*` -- every
 * message is written in plain, non-jargon language in both languages. If
 * a key is ever missing, i18next falls back to printing the key itself,
 * which is at least visibly wrong (easy to spot in testing) rather than
 * silently showing English to an Indonesian-locale user.
 */
export const showUserError = (contextKey, error) => {
  console.error(contextKey, error);
  toast.error(`${i18n.t(contextKey)}. ${i18n.t('common.tryAgainOrContactSupport')}`, { duration: 7000 });
  reportClientError({
    message: error?.message || String(error),
    stack: error?.stack,
    context: { source: 'showUserError', contextKey },
  });
};