/**
 * Tests for Plan Normalizer (guardrails/normalize-plan.ts)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan } from '../../src/guardrails/normalize-plan.js';
import type { ExecutionPlan } from '../../src/types/entities.js';

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    goal: 'test goal',
    steps: [],
    ...overrides,
  };
}

describe('normalizePlan', () => {
  it('passes through a valid plan unchanged', () => {
    const plan = makePlan({
      steps: [
        { stepId: 1, description: 'step 1', operationId: 'echo.items.create', params: { name: 'test' } },
      ],
    });
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].operationId, 'echo.items.create');
    // No major fixes needed (auto-chain is ok)
  });

  it('converts string stepIds to numbers', () => {
    const plan = makePlan({
      steps: [
        { stepId: '1' as unknown as number, description: '', operationId: 'a', params: {} },
        { stepId: '2' as unknown as number, description: '', operationId: 'b', params: {} },
      ],
    });
    const { plan: result } = normalizePlan(plan);
    assert.equal(typeof result.steps[0].stepId, 'number');
    assert.equal(result.steps[0].stepId, 1);
  });

  it('re-indexes non-sequential step IDs', () => {
    const plan = makePlan({
      steps: [
        { stepId: 10, description: '', operationId: 'a', params: {} },
        { stepId: 20, description: '', operationId: 'b', params: {}, dependsOn: [10] },
      ],
    });
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(result.steps[0].stepId, 1);
    assert.equal(result.steps[1].stepId, 2);
    assert.deepEqual(result.steps[1].dependsOn, [1]);
    assert.ok(fixes.includes('re-indexed step IDs'));
  });

  it('removes invalid dependency references', () => {
    const plan = makePlan({
      steps: [
        { stepId: 1, description: '', operationId: 'a', params: {}, dependsOn: [99] },
      ],
    });
    const { plan: result, fixes } = normalizePlan(plan);
    assert.deepEqual(result.steps[0].dependsOn, []);
    assert.ok(fixes.some(f => f.includes('invalid dependencies')));
  });

  it('removes self-references in dependencies', () => {
    const plan = makePlan({
      steps: [
        { stepId: 1, description: '', operationId: 'a', params: {}, dependsOn: [1] },
      ],
    });
    const { plan: result } = normalizePlan(plan);
    assert.deepEqual(result.steps[0].dependsOn, []);
  });

  it('breaks circular dependencies', () => {
    const plan = makePlan({
      steps: [
        { stepId: 1, description: '', operationId: 'a', params: {}, dependsOn: [2] },
        { stepId: 2, description: '', operationId: 'b', params: {}, dependsOn: [1] },
      ],
    });
    const { fixes } = normalizePlan(plan);
    assert.ok(fixes.some(f => f.includes('circular dependency')));
  });

  it('auto-chains orphan steps', () => {
    const plan = makePlan({
      steps: [
        { stepId: 1, description: '', operationId: 'a', params: {} },
        { stepId: 2, description: '', operationId: 'b', params: {} },
        { stepId: 3, description: '', operationId: 'c', params: {} },
      ],
    });
    const { plan: result, fixes } = normalizePlan(plan);
    // Steps 2 and 3 should be auto-chained
    assert.ok(result.steps[1].dependsOn?.includes(1));
    assert.ok(result.steps[2].dependsOn?.includes(2));
    assert.ok(fixes.some(f => f.includes('auto-chained')));
  });

  it('resolves string dependencies via outputRef names', () => {
    const plan = makePlan({
      steps: [
        { stepId: 1, description: '', operationId: 'a', params: {}, outputRef: 'itemA' },
        { stepId: 2, description: '', operationId: 'b', params: {}, dependsOn: ['itemA' as unknown as number] },
      ],
    });
    const { plan: result, fixes } = normalizePlan(plan);
    assert.deepEqual(result.steps[1].dependsOn, [1]);
    assert.ok(fixes.some(f => f.includes('resolved string dep')));
  });

  it('renames "task" field to "goal"', () => {
    const plan = { task: 'my task', steps: [{ stepId: 1, operationId: 'a', params: {}, description: '' }] } as unknown as ExecutionPlan;
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(result.goal, 'my task');
    assert.ok(fixes.includes('renamed "task" to "goal"'));
  });

  it('assigns stepIds when missing', () => {
    const plan = makePlan({
      steps: [
        { stepId: undefined as unknown as number, description: '', operationId: 'a', params: {} },
        { stepId: undefined as unknown as number, description: '', operationId: 'b', params: {} },
      ],
    });
    const { plan: result } = normalizePlan(plan);
    assert.equal(result.steps[0].stepId, 1);
    assert.equal(result.steps[1].stepId, 2);
  });

  it('handles empty plan gracefully', () => {
    const plan = makePlan({ steps: [] });
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(result.steps.length, 0);
    assert.ok(fixes.includes('empty plan'));
  });
});
