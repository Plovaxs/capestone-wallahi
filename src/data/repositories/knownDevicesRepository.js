import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const knownDevicesRepository = {
    findByFingerprint: (userId, fingerprint) => runQuery('knownDevices.findByFingerprint', () =>
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
};
