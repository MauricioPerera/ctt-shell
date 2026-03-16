/**
 * CTT Learn — saves execution results as Skills or Memories.
 */

import type { Store } from '../storage/store.js';
import type { Skill, Memory, ExecutionPlan, ExecutionResult } from '../types/entities.js';
import type { CircuitBreaker } from '../guardrails/circuit-breaker.js';
import { sanitizeSecrets } from '../guardrails/sanitize.js';

/** Save a successful execution as a Skill */
export function learnSkill(
  store: Store,
  plan: ExecutionPlan,
  result: ExecutionResult,
  domainId: string,
): Skill {
  // Check if a similar skill already exists
  const matches = store.findBy<Skill>('skill', s =>
    s.domainId === domainId && s.goal.toLowerCase() === plan.goal.toLowerCase()
  );

  if (matches.length > 0) {
    const existing = matches[0];
    // Update success count
    existing.successCount += 1;
    if (existing.successCount >= 5 && existing.status === 'experimental') {
      existing.status = 'proven';
    }
    return store.save(existing);
  }

  const skill: Skill = {
    id: '',
    type: 'skill',
    domainId,
    createdAt: '',
    updatedAt: '',
    tags: ['auto-learned', domainId],
    name: plan.goal.slice(0, 80),
    description: `Learned from successful execution: ${plan.goal}`,
    goal: plan.goal,
    useCases: [plan.goal],
    steps: plan.steps.map(s => ({
      stepId: s.stepId,
      operationId: s.operationId,
      description: s.description,
      params: JSON.parse(sanitizeSecrets(JSON.stringify(s.params))),
      dependsOn: s.dependsOn,
      outputRef: s.outputRef,
    })),
    status: 'experimental',
    successCount: 1,
    failureCount: 0,
  };

  return store.save(skill);
}

/** Save a failed execution as a Memory + update Circuit Breaker */
export function learnFromError(
  store: Store,
  circuitBreaker: CircuitBreaker,
  plan: ExecutionPlan,
  result: ExecutionResult,
  domainId: string,
): Memory {
  // Update circuit breaker for failed operations
  for (const step of result.steps) {
    if (!step.success && step.error) {
      circuitBreaker.recordError(step.operationId, step.error);
    }
  }

  // Also degrade matching skill if exists
  const matches = store.findBy<Skill>('skill', s =>
    s.domainId === domainId && s.goal.toLowerCase() === plan.goal.toLowerCase()
  );
  if (matches.length > 0) {
    const existing = matches[0];
    existing.failureCount += 1;
    if (existing.failureCount >= 5 && existing.status !== 'deprecated') {
      existing.status = 'deprecated';
    }
    store.save(existing);
  }

  const memory: Memory = {
    id: '',
    type: 'memory',
    domainId,
    createdAt: '',
    updatedAt: '',
    tags: ['auto-error', domainId],
    category: 'error',
    operationId: result.steps.find(s => !s.success)?.operationId,
    content: result.error || 'Unknown error',
    relevance: 1.0,
  };

  return store.save(memory);
}

/** Save an execution fix (when retry succeeded after failure) */
export function learnFix(
  store: Store,
  circuitBreaker: CircuitBreaker,
  operationId: string,
  error: string,
  resolution: string,
  domainId: string,
): Memory {
  circuitBreaker.recordSuccess(operationId);

  const memory: Memory = {
    id: '',
    type: 'memory',
    domainId,
    createdAt: '',
    updatedAt: '',
    tags: ['auto-fix', domainId],
    category: 'fix',
    operationId,
    content: error,
    resolution,
    relevance: 1.0,
  };

  return store.save(memory);
}
