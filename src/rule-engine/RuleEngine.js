const OPERATORS = {
    equals: (a, b) => a === b,
    notEquals: (a, b) => a !== b,
    greaterThan: (a, b) => a > b,
    greaterThanOrEqual: (a, b) => a >= b,
    lessThan: (a, b) => a < b,
    lessThanOrEqual: (a, b) => a <= b,
    in: (a, b) => Array.isArray(b) && b.includes(a),
};

function evaluateCondition(condition, facts) {
    if (condition.all) return condition.all.every((c) => evaluateCondition(c, facts));
    if (condition.any) return condition.any.some((c) => evaluateCondition(c, facts));
    const operatorFn = OPERATORS[condition.operator];
    if (!operatorFn) throw new Error(`Unknown rule operator: ${condition.operator}`);
    return operatorFn(facts[condition.fact], condition.value);
}

/**
 * Minimal declarative rule engine. Rules are plain JSON — no eval() or
 * new Function() — so a config-driven rule set can never execute
 * arbitrary code. Each rule has a `when` condition tree (all/any branches,
 * fact/operator/value leaves) and a `then` payload; run() returns every
 * rule whose condition matched the given facts.
 */
export class RuleEngine {
    constructor(rules = []) {
        this.rules = rules;
    }

    run(facts) {
        return this.rules
            .filter((rule) => evaluateCondition(rule.when, facts))
            .map((rule) => ({ rule, action: rule.then }));
    }
}
