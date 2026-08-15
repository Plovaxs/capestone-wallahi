import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

// 🟩 COLUMN-SELECTION OPTIMIZATION: listAll() feeds allUsers, which is
// broadcast broadly (Sidebar, Header, task-assignee pickers, leaderboards,
// ...) but nothing outside a user's own profile ever reads
// face_descriptor — it's only used via profilesRepository.getById(), for
// the logged-in user themselves. face_descriptor is now a multi-angle
// array (several 128-number templates), so including it in every bulk
// listAll() meant downloading everyone's biometric templates on every
// page that just needs names/roles. Excluding it here noticeably shrinks
// that payload without touching anything that actually reads it.
const PROFILE_LIST_COLUMNS = 'id, name, role, initials, vacation_days, sick_days, avatar_url, work_mode, source, email, department, position, job_desk, contract_start_date, contract_end_date, loa_file_path, is_team_lead';

export const profilesRepository = {
    // 🟩 SECURITY: label includes userId -- runQuery's in-flight dedup keys
    // purely on this string, so two concurrent calls for two DIFFERENT
    // users (e.g. a shared-device login switch while the first user's
    // fetch is still in flight) must not collapse into one shared promise
    // and hand user B the response meant for user A.
    getById: (userId) => runQuery(`profiles.getById:${userId}`, () =>
        supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
    ),

    listAll: () => runQuery('profiles.listAll', () =>
        supabase.from('profiles').select(PROFILE_LIST_COLUMNS)
    ),

    update: (id, patch) => runMutation('profiles.update', () =>
        supabase.from('profiles').update(patch).eq('id', id)
    ),

    // 🟩 Ghost-employee / duplicate-enrollment detection (see
    // migrations/20260810_add_duplicate_enrollment_detection.sql) -- the
    // comparison runs entirely server-side (Postgres RPC, SECURITY DEFINER,
    // supervisor-gated inside the function itself); face_descriptor is
    // never bulk-fetched to the client to do this, matching this file's
    // existing column-selection discipline above.
    findDuplicateEnrollments: () => runQuery('profiles.findDuplicateEnrollments', () =>
        supabase.rpc('find_duplicate_enrollments')
    ),

    // 🟩 Debug Center "whose face is this" testing feature -- same
    // server-side-only comparison discipline as findDuplicateEnrollments
    // above: the live descriptor goes in, only the best match's identity
    // and distance come back, nobody's stored template ever reaches the
    // client. Supervisor-gated inside the RPC itself.
    identifyFaceByDescriptor: (liveDescriptor, threshold) => runQuery('profiles.identifyFaceByDescriptor', () =>
        supabase.rpc('identify_face_by_descriptor', { p_descriptor: liveDescriptor, p_threshold: threshold })
    ),
};
