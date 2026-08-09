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
const PROFILE_LIST_COLUMNS = 'id, name, role, initials, vacation_days, sick_days, avatar_url, work_mode, source, email, department, position, job_desk, contract_start_date, contract_end_date';

export const profilesRepository = {
    getById: (userId) => runQuery('profiles.getById', () =>
        supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
    ),

    listAll: () => runQuery('profiles.listAll', () =>
        supabase.from('profiles').select(PROFILE_LIST_COLUMNS)
    ),

    update: (id, patch) => runMutation('profiles.update', () =>
        supabase.from('profiles').update(patch).eq('id', id)
    ),
};
