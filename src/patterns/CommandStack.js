/**
 * Command pattern + Memento: each executed command knows how to reverse
 * itself (`undo`), so the stack can walk backward/forward through history
 * without the caller having to remember what changed. Powers the "Undo"
 * toast action on task status changes.
 */
export class CommandStack {
    constructor({ limit = 20 } = {}) {
        this.undoStack = [];
        this.redoStack = [];
        this.limit = limit;
    }

    async execute(command) {
        await command.do();
        this.undoStack.push(command);
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack = [];
    }

    async undo() {
        const command = this.undoStack.pop();
        if (!command) return false;
        await command.undo();
        this.redoStack.push(command);
        return true;
    }

    async redo() {
        const command = this.redoStack.pop();
        if (!command) return false;
        await command.do();
        this.undoStack.push(command);
        return true;
    }

    canUndo() {
        return this.undoStack.length > 0;
    }

    canRedo() {
        return this.redoStack.length > 0;
    }
}
