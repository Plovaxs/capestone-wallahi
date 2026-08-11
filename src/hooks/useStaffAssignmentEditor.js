import { useState } from 'react';
import { supabase } from '../supabaseClient';
import { showUserError } from '../utils/errorHandling';

const EMPTY_DRAFT = {
    name: '', source: '', department: '', position: '', job_desk: '',
    work_mode: 'WFO', contract_start_date: '', contract_end_date: '',
};

/**
 * Single source of truth for "supervisor edits an employee's assignment
 * fields" (name/institution/department/position/job desk/duty mode/
 * contract period) -- shared by Settings > Manage Staff Assignments and
 * Dashboard's Outsource Directory (inline table editing) so the field
 * list and save mutation can't drift between the two places that offer
 * the exact same capability.
 *
 * @param {() => void} [fetchAllUsers] - re-fetches the roster after a successful save, so the edited row reflects the new values immediately
 */
export function useStaffAssignmentEditor(fetchAllUsers) {
    const [editingId, setEditingId] = useState(null);
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    const [savingId, setSavingId] = useState(null);

    const startEdit = (emp) => {
        setEditingId(emp.id);
        setDraft({
            name: emp.name || '',
            source: emp.source || '',
            department: emp.department || '',
            position: emp.position || '',
            job_desk: emp.job_desk || '',
            work_mode: emp.work_mode || 'WFO',
            contract_start_date: emp.contract_start_date || '',
            contract_end_date: emp.contract_end_date || '',
        });
    };

    const cancelEdit = () => setEditingId(null);

    const updateField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

    const save = async (targetId) => {
        setSavingId(targetId);
        try {
            const { error } = await supabase
                .from('profiles')
                .update({
                    name: draft.name || null,
                    source: draft.source || null,
                    department: draft.department || null,
                    position: draft.position || null,
                    job_desk: draft.job_desk || null,
                    work_mode: draft.work_mode || 'WFO',
                    contract_start_date: draft.contract_start_date || null,
                    contract_end_date: draft.contract_end_date || null,
                })
                .eq('id', targetId);

            if (error) {
                showUserError('errors.updateAssignment', error);
                return false;
            }
            setEditingId(null);
            // 🟩 BUG FIX: this used to fire-and-forget the roster refetch,
            // so `finally` re-enabled the Save/edit UI (setSavingId(null))
            // before the refetch actually completed -- a supervisor could
            // re-open the edit form or fire a second save while the roster
            // still reflected pre-save data, and any rejection here became
            // an unhandled promise rejection instead of a visible error.
            if (fetchAllUsers) await fetchAllUsers();
            return true;
        } catch (err) {
            // A thrown (not just {error}) network failure previously left
            // the Save button stuck disabled forever until a full reload.
            showUserError('errors.updateAssignment', err);
            return false;
        } finally {
            setSavingId(null);
        }
    };

    return { editingId, draft, savingId, startEdit, cancelEdit, updateField, save };
}
