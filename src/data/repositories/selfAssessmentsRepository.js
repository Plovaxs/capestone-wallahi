import { supabase } from '../../supabaseClient';
import { runQuery, runMutation } from './apiClient';

export const selfAssessmentsRepository = {
    // RLS scopes this to the caller's own rows, or every row for a
    // supervisor -- no need to filter client-side.
    listAll: () => runQuery('selfAssessments.listAll', () =>
        supabase.from('self_assessments').select('*').order('submitted_at', { ascending: false })
    ),

    // Append-only, same pattern as performance_evaluations -- a new
    // self-assessment is a new row, not an edit of a past one, preserving
    // history of how someone rated themselves each review period.
    submit: (employeeId, scores, comments) => runMutation('selfAssessments.submit', () =>
        supabase.from('self_assessments').insert({ employee_id: employeeId, scores, comments })
    ),
};
