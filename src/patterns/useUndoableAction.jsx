import { useRef } from 'react';
import toast from 'react-hot-toast';
import { CommandStack } from './CommandStack';
import { showUserError } from '../utils/errorHandling';

/**
 * Executes a { do, undo, label } command through a per-component
 * CommandStack and surfaces an "Undo" action on the success toast for a
 * few seconds — the Command pattern applied to everyday mutations instead
 * of just a generic architecture diagram.
 */
export function useUndoableAction() {
    const stackRef = useRef(new CommandStack());

    const runUndoable = async (command, { undoLabel = 'Undo' } = {}) => {
        await stackRef.current.execute(command);

        toast((activeToast) => (
            <span className="flex items-center gap-3">
                <span>{command.label}</span>
                <button
                    type="button"
                    onClick={async () => {
                        try {
                            await stackRef.current.undo();
                            toast.dismiss(activeToast.id);
                        } catch (err) {
                            // Previously an unhandled rejection: if the reversing
                            // call failed (e.g. network drop), the toast just
                            // dismissed as if undo had succeeded, with the
                            // original mutation silently still in effect.
                            showUserError('errors.undo', err);
                        }
                    }}
                    className="font-bold text-blue-600 dark:text-blue-400 hover:underline"
                >
                    {undoLabel}
                </button>
            </span>
        ), { duration: 6000 });
    };

    return { runUndoable, commandStack: stackRef.current };
}
