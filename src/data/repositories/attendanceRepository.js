import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const attendanceRepository = {
    listAll: () => runQuery('attendance.listAll', () =>
        supabase.from('attendance').select('*').order('date', { ascending: false })
    ),

    // 🟩 SECURITY: label includes employeeId+date -- see
    // profilesRepository.getById's comment for why (runQuery's in-flight
    // dedup would otherwise hand one employee's "already clocked in?"
    // answer to a different employee's concurrent check).
    findByEmployeeAndDate: (employeeId, date) => runQuery(`attendance.findByEmployeeAndDate:${employeeId}:${date}`, () =>
        supabase.from('attendance').select('id').eq('employee_id', employeeId).eq('date', date).maybeSingle()
    ),

    insert: (payload) => runMutation('attendance.insert', () =>
        supabase.from('attendance').insert(payload)
    ),

    update: (id, patch) => runMutation('attendance.update', () =>
        supabase.from('attendance').update(patch).eq('id', id)
    ),
};
