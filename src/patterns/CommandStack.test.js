import { describe, it, expect, vi } from 'vitest';
import { CommandStack } from './CommandStack';

const makeCommand = () => {
    let value = 'initial';
    return {
        do: vi.fn(async () => { value = 'changed'; }),
        undo: vi.fn(async () => { value = 'initial'; }),
        getValue: () => value,
    };
};

describe('CommandStack', () => {
    it('runs the command on execute()', async () => {
        const stack = new CommandStack();
        const command = makeCommand();

        await stack.execute(command);

        expect(command.do).toHaveBeenCalledTimes(1);
        expect(command.getValue()).toBe('changed');
        expect(stack.canUndo()).toBe(true);
        expect(stack.canRedo()).toBe(false);
    });

    it('reverses the command on undo() and moves it to the redo stack', async () => {
        const stack = new CommandStack();
        const command = makeCommand();

        await stack.execute(command);
        const undone = await stack.undo();

        expect(undone).toBe(true);
        expect(command.undo).toHaveBeenCalledTimes(1);
        expect(command.getValue()).toBe('initial');
        expect(stack.canUndo()).toBe(false);
        expect(stack.canRedo()).toBe(true);
    });

    it('re-applies the command on redo()', async () => {
        const stack = new CommandStack();
        const command = makeCommand();

        await stack.execute(command);
        await stack.undo();
        const redone = await stack.redo();

        expect(redone).toBe(true);
        expect(command.do).toHaveBeenCalledTimes(2);
        expect(command.getValue()).toBe('changed');
    });

    it('undo() returns false when there is nothing to undo', async () => {
        const stack = new CommandStack();
        expect(await stack.undo()).toBe(false);
    });

    it('clears the redo stack once a new command is executed', async () => {
        const stack = new CommandStack();
        await stack.execute(makeCommand());
        await stack.undo();
        expect(stack.canRedo()).toBe(true);

        await stack.execute(makeCommand());
        expect(stack.canRedo()).toBe(false);
    });
});
