import { describe, it, expect } from 'vitest';
import { RuleEngine } from './RuleEngine';
import { evaluateTaskEscalation } from './taskEscalationRules';

describe('RuleEngine', () => {
    it('matches a rule whose single condition passes', () => {
        const engine = new RuleEngine([
            { id: 'r1', when: { fact: 'x', operator: 'equals', value: 1 }, then: { action: 'go' } },
        ]);
        expect(engine.run({ x: 1 })).toHaveLength(1);
        expect(engine.run({ x: 2 })).toHaveLength(0);
    });

    it('supports "all" (AND) condition groups', () => {
        const engine = new RuleEngine([
            {
                id: 'r1',
                when: { all: [
                    { fact: 'a', operator: 'equals', value: 1 },
                    { fact: 'b', operator: 'equals', value: 2 },
                ] },
                then: { action: 'go' },
            },
        ]);
        expect(engine.run({ a: 1, b: 2 })).toHaveLength(1);
        expect(engine.run({ a: 1, b: 3 })).toHaveLength(0);
    });

    it('supports "any" (OR) condition groups', () => {
        const engine = new RuleEngine([
            {
                id: 'r1',
                when: { any: [
                    { fact: 'a', operator: 'equals', value: 1 },
                    { fact: 'b', operator: 'equals', value: 2 },
                ] },
                then: { action: 'go' },
            },
        ]);
        expect(engine.run({ a: 1, b: 999 })).toHaveLength(1);
        expect(engine.run({ a: 999, b: 2 })).toHaveLength(1);
        expect(engine.run({ a: 999, b: 999 })).toHaveLength(0);
    });

    it('supports comparison operators beyond equals', () => {
        const engine = new RuleEngine([
            { id: 'r1', when: { fact: 'n', operator: 'greaterThan', value: 5 }, then: { action: 'go' } },
        ]);
        expect(engine.run({ n: 10 })).toHaveLength(1);
        expect(engine.run({ n: 3 })).toHaveLength(0);
    });
});

describe('evaluateTaskEscalation', () => {
    it('returns critical for an overdue High priority task', () => {
        const result = evaluateTaskEscalation({ priority: 'High', status: 'In Progress' }, 'Overdue');
        expect(result.action.severity).toBe('critical');
    });

    it('returns warning for an overdue Normal priority task', () => {
        const result = evaluateTaskEscalation({ priority: 'Normal', status: 'In Progress' }, 'Overdue');
        expect(result.action.severity).toBe('warning');
    });

    it('returns null when nothing matches', () => {
        const result = evaluateTaskEscalation({ priority: 'Low', status: 'To Do' }, 'Normal');
        expect(result).toBeNull();
    });
});
