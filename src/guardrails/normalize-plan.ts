/**
 * Plan Normalizer — fixes structural issues in LLM-generated execution plans.
 *
 * Adapted from wp-a2e's normalize-plan.ts, made generic for ExecutionPlan.
 * Domain-specific fixes (PATCH→POST, WC endpoints, taxonomy refs) are removed;
 * those belong in domain adapters.
 *
 * Handles:
 * - String stepId → number conversion
 * - Sequential re-indexing
 * - String deps → number (via outputRef map)
 * - Circular dependency breaking
 * - Orphan auto-chaining
 * - Object outputRef → string
 * - Ref prefix stripping ({{ref.name.id}} → {{name.id}})
 * - Fuzzy ref resolution
 */

import type { ExecutionPlan, ExecutionStep } from '../types/entities.js';

export interface NormalizePlanResult {
  plan: ExecutionPlan;
  fixes: string[];
}

export function normalizePlan(plan: ExecutionPlan): NormalizePlanResult {
  const fixes: string[] = [];

  // Pre-process: handle alternative plan structures from various models
  // Some models use "task"/"description" instead of "goal"
  const planAny = plan as unknown as Record<string, unknown>;
  if (!plan.goal && planAny.task) {
    plan.goal = planAny.task as string;
    fixes.push('renamed "task" to "goal"');
  }
  if (!plan.goal && planAny.description) {
    plan.goal = planAny.description as string;
    fixes.push('renamed "description" to "goal"');
  }

  // Handle steps that use alternative field names, string IDs, missing fields, etc.
  const rawSteps = plan.steps || [];
  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i] as unknown as Record<string, unknown>;
    // Convert string stepId to number
    if (typeof s.stepId === 'string') {
      const num = parseInt(s.stepId, 10);
      s.stepId = isNaN(num) ? i + 1 : num;
    }
    if (s.stepId === undefined || s.stepId === null) {
      s.stepId = i + 1;
      fixes.push(`assigned stepId ${i + 1} to step "${s.description || s.operationId || i}"`);
    }

    // Ensure required fields have defaults
    if (!s.operationId) {
      s.operationId = 'unknown';
      fixes.push(`defaulted step ${s.stepId} operationId to "unknown"`);
    }
    if (!s.params) s.params = {};

    // Fix outputRef: if it's an object instead of a string, convert
    if (s.outputRef && typeof s.outputRef === 'object') {
      const refName = `step${s.stepId}Output`;
      fixes.push(`converted object outputRef to "${refName}"`);
      s.outputRef = refName;
    }
  }

  // Handle string-based dependsOn that reference outputRef names instead of step IDs
  const refToStepId = new Map<string, number>();
  for (const s of rawSteps) {
    if (typeof s.outputRef === 'string') refToStepId.set(s.outputRef, s.stepId);
    const anyS = s as unknown as Record<string, unknown>;
    if (anyS.name && typeof anyS.name === 'string') refToStepId.set(anyS.name, s.stepId);
  }

  for (const s of rawSteps) {
    if (s.dependsOn && Array.isArray(s.dependsOn)) {
      s.dependsOn = (s.dependsOn as unknown[]).map((dep: unknown) => {
        if (typeof dep === 'string') {
          const resolved = refToStepId.get(dep);
          if (resolved !== undefined) {
            fixes.push(`resolved string dep "${dep}" → step ${resolved}`);
            return resolved;
          }
          // Try parsing as number
          const num = parseInt(dep, 10);
          if (!isNaN(num)) return num;
          fixes.push(`dropped unresolvable dep "${dep}"`);
          return -1;
        }
        return dep as number;
      }).filter((d: number) => d > 0);
    }
  }

  // Strip known bad ref prefixes: {{ref.name.id}} → {{name.id}}, {{output.name.id}} → {{name.id}}
  for (const s of rawSteps) {
    stripRefPrefixes(s.params, rawSteps, fixes);
  }

  // Fix {{outputRef.field}} references in params — resolve to actual outputRef names
  for (const s of rawSteps) {
    fixParamRefs(s.params, rawSteps, fixes);
  }

  let steps = [...rawSteps.map(s => ({ ...s }))];

  if (steps.length === 0) {
    return { plan, fixes: ['empty plan'] };
  }

  // Fix 1: Ensure sequential step IDs starting from 1
  const idMap = new Map<number, number>();
  const needsReindex = steps.some((s, i) => s.stepId !== i + 1);
  if (needsReindex) {
    steps.forEach((s, i) => {
      const oldId = s.stepId;
      const newId = i + 1;
      idMap.set(oldId, newId);
      s.stepId = newId;
    });
    // Remap dependencies
    for (const step of steps) {
      if (step.dependsOn) {
        step.dependsOn = step.dependsOn
          .map(dep => idMap.get(dep) ?? dep)
          .filter(dep => dep >= 1 && dep <= steps.length);
      }
    }
    fixes.push('re-indexed step IDs');
  }

  // Fix 2: Remove references to non-existent steps
  const validIds = new Set(steps.map(s => s.stepId));
  for (const step of steps) {
    if (step.dependsOn) {
      const before = step.dependsOn.length;
      step.dependsOn = step.dependsOn.filter(dep => validIds.has(dep) && dep !== step.stepId);
      if (step.dependsOn.length !== before) {
        fixes.push(`removed invalid dependencies from step ${step.stepId}`);
      }
    }
  }

  // Fix 3: Break circular dependencies (single-pass DFS with 3 states)
  const state = new Map<number, 'visiting' | 'done'>();
  const stepMap = new Map(steps.map(s => [s.stepId, s]));

  function visit(id: number): void {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') return;
    state.set(id, 'visiting');
    const step = stepMap.get(id);
    if (step?.dependsOn) {
      step.dependsOn = step.dependsOn.filter(dep => {
        if (state.get(dep) === 'visiting') {
          fixes.push(`broke circular dependency: step ${id} → ${dep}`);
          return false;
        }
        visit(dep);
        return true;
      });
    }
    state.set(id, 'done');
  }

  for (const step of steps) visit(step.stepId);

  // Fix 4: Auto-chain orphan steps (steps with no dependsOn and not step 1)
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i];
    const isReferenced = steps.some(s => s.dependsOn?.includes(step.stepId));
    const hasDeps = step.dependsOn && step.dependsOn.length > 0;

    if (!hasDeps && !isReferenced && i > 0) {
      step.dependsOn = [steps[i - 1].stepId];
      fixes.push(`auto-chained orphan step ${step.stepId} → ${steps[i - 1].stepId}`);
    }
  }

  return {
    plan: { ...plan, steps },
    fixes,
  };
}

/**
 * Strip known bad ref prefixes that models generate.
 * E.g., {{ref.stepName.id}} → {{stepName.id}}
 *       {{output.stepName.id}} → {{stepName.id}}
 */
function stripRefPrefixes(params: Record<string, unknown>, allSteps: ExecutionStep[], fixes: string[]): void {
  if (!params) return;
  const knownPrefixes = ['ref.', 'output.', 'step.'];
  const outputRefs = new Set(allSteps.map(s => s.outputRef).filter(Boolean));

  function stripOne(val: string): string {
    if (!val.includes('{{')) return val;
    return val.replace(/\{\{(.+?)\}\}/g, (match, inner) => {
      const trimmed = (inner as string).trim();
      for (const prefix of knownPrefixes) {
        if (trimmed.startsWith(prefix)) {
          const stripped = trimmed.slice(prefix.length);
          const [candidate] = stripped.split('.');
          // Only strip if the result looks like a valid outputRef
          if (outputRefs.has(candidate)) {
            fixes.push(`stripped "${prefix}" prefix from ref`);
            return `{{${stripped}}}`;
          }
        }
      }
      return match;
    });
  }

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      params[key] = stripOne(value);
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'string') {
          value[i] = stripOne(value[i] as string);
        }
      }
    }
  }
}

/**
 * Fix param references that don't match expected {{outputRef.field}} format.
 * Uses fuzzy matching against dependency steps when exact match fails.
 */
function fixParamRefs(params: Record<string, unknown>, allSteps: ExecutionStep[], fixes: string[]): void {
  if (!params) return;
  const currentStep = allSteps.find(s => s.params === params);

  function resolveUnknownRef(refName: string): string | undefined {
    // 1. Try fuzzy match against ALL steps' outputRef names
    const fuzzy = allSteps.find(s =>
      typeof s.outputRef === 'string' && s.outputRef && (
        refName.toLowerCase().includes(s.outputRef.toLowerCase()) ||
        s.outputRef.toLowerCase().includes(refName.toLowerCase())
      )
    );
    if (fuzzy?.outputRef) return fuzzy.outputRef;

    // 2. Try matching against dependency steps specifically
    if (currentStep?.dependsOn?.length) {
      const depSteps = currentStep.dependsOn
        .map(id => allSteps.find(s => s.stepId === id))
        .filter((s): s is ExecutionStep => !!s && typeof s.outputRef === 'string');

      // Fuzzy match ref name against dep outputRefs
      const depMatch = depSteps.find(s =>
        refName.toLowerCase().includes(s.outputRef!.toLowerCase()) ||
        s.outputRef!.toLowerCase().includes(refName.toLowerCase())
      );
      if (depMatch?.outputRef) return depMatch.outputRef;

      // Single dep fallback
      if (depSteps.length === 1 && depSteps[0].outputRef) return depSteps[0].outputRef;
    }

    // 3. Global single-ref fallback
    const stepsWithRef = allSteps.filter(s => typeof s.outputRef === 'string' && s.outputRef);
    if (stepsWithRef.length === 1) return stepsWithRef[0].outputRef;

    return undefined;
  }

  function fixRef(original: string): string | undefined {
    const ref = original.slice(original.indexOf('{{') + 2, original.indexOf('}}')).trim();
    const [refName] = ref.split('.');
    // Already valid?
    if (allSteps.some(s => s.outputRef === refName)) return undefined;

    const resolved = resolveUnknownRef(refName);
    if (resolved) {
      fixes.push(`fixed ref "${original}" → "{{${resolved}.id}}"`);
      return `{{${resolved}.id}}`;
    }
    return undefined;
  }

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.includes('{{')) {
      const fixed = fixRef(value);
      if (fixed) params[key] = fixed;
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'string' && (value[i] as string).includes('{{')) {
          const fixed = fixRef(value[i] as string);
          if (fixed) value[i] = fixed;
        }
      }
    }
  }
}
