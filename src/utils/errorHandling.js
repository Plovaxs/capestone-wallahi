import toast from 'react-hot-toast';
import i18n from '../i18n';

/**
 * Logs the real error for debugging and shows the user a generic,
 * non-leaking message instead of raw Postgres/PostgREST error text
 * (which can expose table/column/constraint names to any authenticated
 * user probing the app). Uses the i18n instance directly (not the
 * useTranslation hook) since this is a plain utility, not a component.
 */
export const showUserError = (context, error) => {
  console.error(context, error);
  toast.error(`${context}. ${i18n.t('common.tryAgainOrContactSupport')}`);
};