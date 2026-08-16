import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

// 🟩 Global, database-backed key-value settings -- deliberately NOT the
// existing per-browser FeatureFlagService (src/feature-flags/), which is
// a localStorage override invisible to every other browser/device. This
// table is for settings a supervisor toggles ONCE that need to apply for
// every user, everywhere -- see migrations/20260815c_add_system_settings.sql
// (publicly readable, including by the anon role, since the first setting
// gates a check that runs on LoginPage.jsx before the user is
// authenticated; writable only by supervisors, enforced by RLS).
export const systemSettingsRepository = {
    get: (key) => runQuery(`systemSettings.get:${key}`, () =>
        supabase.from('system_settings').select('value').eq('key', key).maybeSingle()
    ),

    set: (key, value) => runMutation(`systemSettings.set:${key}`, () =>
        supabase.from('system_settings').upsert({ key, value, updated_at: new Date().toISOString() })
    ),
};
