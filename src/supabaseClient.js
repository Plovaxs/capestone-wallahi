import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// 🟩 FAIL FAST: createClient() with an undefined URL doesn't error here --
// it throws later, deep inside whatever the first network call happens to
// be, as an opaque "Failed to construct 'URL': Invalid URL" with no
// mention of Supabase or env vars at all. Missing/misconfigured env vars
// are a setup mistake (forgot to copy .env.example to .env), not a
// runtime condition the app should try to run through -- surface it
// immediately, at the actual cause, with the actual fix.
if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
        'Missing Supabase configuration: VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY are not set. ' +
        'Copy .env.example to .env and fill in your Supabase project\'s URL and anon key (Project Settings > API).'
    );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export { supabaseUrl, supabaseAnonKey };

