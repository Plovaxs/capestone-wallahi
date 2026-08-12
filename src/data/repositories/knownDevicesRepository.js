import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const knownDevicesRepository = {
    // 🟩 SECURITY: label includes userId+fingerprint -- see
    // profilesRepository.getById's comment for why (runQuery's in-flight
    // dedup would otherwise hand one user's device-trust verdict to a
    // different user's concurrent check on a shared-device login switch).
    findByFingerprint: (userId, fingerprint) => runQuery(`knownDevices.findByFingerprint:${userId}:${fingerprint}`, () =>
        supabase.from('known_devices').select('id').eq('user_id', userId).eq('fingerprint', fingerprint).maybeSingle()
    ),

    touchLastSeen: (id) => runMutation('knownDevices.touchLastSeen', () =>
        supabase.from('known_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', id)
    ),

    // A fresh row here fires the notify_new_device trigger (see
    // migrations/20260810_add_device_trust.sql) -- logging + notifying the
    // account owner is handled server-side, not duplicated here.
    recordNewDevice: (userId, fingerprint, label) => runMutation('knownDevices.recordNewDevice', () =>
        supabase.from('known_devices').insert({ user_id: userId, fingerprint, label })
    ),

    // Supervisor-facing: every known device across every employee, most
    // recently seen first -- RLS already scopes this to what a supervisor
    // (or the caller's own rows) may see.
    listAll: () => runQuery('knownDevices.listAll', () =>
        supabase.from('known_devices').select('*').order('last_seen_at', { ascending: false })
    ),

    // Self-service "Trusted Devices" list for Settings > Security -- same
    // underlying table as listAll, but labeled/keyed per-caller so a
    // supervisor viewing their OWN devices doesn't share a cache entry
    // with the all-employees supervisor panel.
    listForUser: (userId) => runQuery(`knownDevices.listForUser:${userId}`, () =>
        supabase.from('known_devices').select('*').eq('user_id', userId).order('last_seen_at', { ascending: false })
    ),

    // Lets a user revoke a device's "known/trusted" status from their own
    // Security settings (e.g. a shared/borrowed device they no longer use).
    // Purely a trust-list removal -- it does NOT terminate that device's
    // current session; see handleSignOutEverywhere's global signOut for that.
    revoke: (id) => runMutation('knownDevices.revoke', () =>
        supabase.from('known_devices').delete().eq('id', id)
    ),
};
