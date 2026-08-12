import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../supabaseClient';
import { Icons } from './Icons';
import Button from './Button';

// 🟩 SECURITY: this is the actual enforcement point for Settings >
// Security's "Enable 2FA" toggle. supabase.auth.signInWithPassword()
// already grants a valid (AAL1) session even for a user with a verified
// TOTP factor -- Supabase does not block the password step itself, it
// just marks that session as needing to step up to AAL2. Without this
// gate, App.jsx would let an AAL1 session straight into the app and 2FA
// would be purely cosmetic. Rendered by App.jsx in place of the main app
// whenever `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` reports
// nextLevel 'aal2' and currentLevel hasn't reached it yet.
const MfaChallengeGate = ({ onVerified, onSignOut }) => {
  const { t } = useTranslation();
  const [factorId, setFactorId] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.mfa.listFactors().then(({ data, error: listError }) => {
      if (cancelled) return;
      if (listError) { setError(listError.message); setLoading(false); return; }
      const verified = (data?.totp || []).find(f => f.status === 'verified');
      setFactorId(verified?.id || null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!factorId || code.length < 6) return;
    setVerifying(true);
    setError('');
    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
      if (verifyError) { setError(t('errors.mfaCodeInvalid')); return; }
      onVerified();
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="flex flex-col justify-center items-center h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="w-full max-w-sm bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <div className="h-12 w-12 rounded-full bg-brand-50 dark:bg-brand-900/40 flex items-center justify-center text-brand-600 dark:text-brand-400 mb-4">
          <span className="h-6 w-6 inline-flex">{Icons.ShieldCheck}</span>
        </div>
        <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-1">{t('settings.mfaChallengeTitle')}</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-5">{t('settings.mfaChallengeHint')}</p>

        {loading ? (
          <div className="h-11 rounded-xl bg-gray-100 dark:bg-gray-700 animate-pulse" />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              autoFocus
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="w-full p-3 border border-gray-200 dark:border-gray-600 rounded-xl dark:bg-gray-900/40 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono text-center tracking-widest text-lg"
            />
            {error && <p role="alert" className="text-red-600 dark:text-red-400 text-xs">{error}</p>}
            <Button type="submit" className="w-full" disabled={code.length < 6 || !factorId} loading={verifying}>
              {t('settings.mfaChallengeSubmit')}
            </Button>
            <button
              type="button"
              onClick={onSignOut}
              className="w-full text-center text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 bg-transparent border-none cursor-pointer py-1"
            >
              {t('header.logout')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default MfaChallengeGate;
