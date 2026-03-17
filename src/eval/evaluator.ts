/**
 * Model Evaluator — runs goals against LLM providers and measures metrics.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmProvider, LlmMessage } from '../llm/provider.js';
import type { ExecutionPlan } from '../types/entities.js';
import type { DomainAdapter } from '../domain/adapter.js';
import { normalizeResponse } from '../guardrails/normalize-response.js';
import { normalizePlan } from '../guardrails/normalize-plan.js';

export interface EvalGoal {
  goal: string;
  domainId: string;
  tags?: string[];
  complexity?: 'simple' | 'medium' | 'complex';
  expectedOps?: string[];  // Expected operation IDs in the plan
}

export interface EvalModelConfig {
  name: string;
  provider: import('../llm/provider.js').ProviderType;
  config: Record<string, unknown>;
}

export interface EvalRunResult {
  goal: string;
  model: string;
  jsonValid: boolean;
  planValid: boolean;
  compositionPassed: boolean;
  executionPassed: boolean;
  executionError?: string;
  rawResponse?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  stepCount: number;
  normalizeFixes: string[];
}

export interface EvalReport {
  timestamp: string;
  goals: EvalGoal[];
  results: EvalRunResult[];
  summary: {
    model: string;
    jsonRate: number;
    planRate: number;
    compositionRate: number;
    executionRate: number;
    avgLatencyMs: number;
    avgSteps: number;
  }[];
}

export interface ComparisonDelta {
  model: string;
  jsonRate: number;
  planRate: number;
  compositionRate: number;
  executionRate: number;
  latencyDelta: number;
  regressions: string[];
}

export interface ComparisonResult {
  deltas: ComparisonDelta[];
  hasRegressions: boolean;
}

export class ModelEvaluator {
  private systemPrompt: string;
  private contextGenerator?: (goal: string, compact: boolean) => string;
  private domainAdapters?: Map<string, DomainAdapter>;
  private executeAfterPlan: boolean;

  constructor(opts?: {
    systemPrompt?: string;
    contextGenerator?: (goal: string, compact: boolean) => string;
    domainAdapters?: Map<string, DomainAdapter>;
    executeAfterPlan?: boolean;
  }) {
    this.systemPrompt = opts?.systemPrompt || DEFAULT_EVAL_SYSTEM_PROMPT;
    this.contextGenerator = opts?.contextGenerator;
    this.domainAdapters = opts?.domainAdapters;
    this.executeAfterPlan = opts?.executeAfterPlan ?? false;
  }

  async runOne(
    goal: EvalGoal,
    model: EvalModelConfig,
    llm: LlmProvider,
  ): Promise<EvalRunResult> {
    const result: EvalRunResult = {
      goal: goal.goal,
      model: model.name,
      jsonValid: false,
      planValid: false,
      compositionPassed: false,
      executionPassed: false,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
      normalizeFixes: [],
    };

    const modelId = String(model.config.model ?? '').toLowerCase();
    const isSmall = /\b(1b|3b|0\.5b|1\.8b|tiny)\b/.test(modelId);

    const context = this.contextGenerator
      ? this.contextGenerator(goal.goal, isSmall)
      : '';

    const messages: LlmMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: context ? `${context}\n\n## Goal\n${goal.goal}` : goal.goal },
    ];

    // Auto-detect Qwen models and append /no_think
    if (/qwen/i.test(modelId)) {
      messages[messages.length - 1].content += ' /no_think';
    }

    const start = Date.now();
    const maxAttempts = isSmall ? 2 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await llm.chat(messages, { temperature: 0.1, maxTokens: 4096 });
        result.latencyMs = Date.now() - start;
        result.rawResponse = response.content;
        result.inputTokens += response.usage?.inputTokens ?? 0;
        result.outputTokens += response.usage?.outputTokens ?? 0;

        // JSON extraction
        const normalized = normalizeResponse(response.content);
        if (!normalized.json) {
          if (attempt < maxAttempts - 1) {
            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: 'Response was truncated. Be more concise: short descriptions, no extra fields. JSON only.' });
            continue;
          }
          break;
        }
        result.jsonValid = true;

        // Parse plan
        const plan = JSON.parse(normalized.json) as ExecutionPlan;
        if (!plan.goal && !plan.steps) break;
        if (!plan.steps || !Array.isArray(plan.steps)) break;
        if (!plan.goal) plan.goal = goal.goal;
        result.planValid = true;

        // Normalize
        const { plan: normalizedPlan, fixes } = normalizePlan(plan);
        result.normalizeFixes = fixes;
        result.stepCount = normalizedPlan.steps.length;

        // Basic validation: all steps have operationId and params
        const valid = normalizedPlan.steps.every(s => s.operationId && s.params);
        result.compositionPassed = valid && normalizedPlan.steps.length > 0;

        // Execution testing (if enabled and composition passed)
        if (result.compositionPassed && this.executeAfterPlan && this.domainAdapters) {
          const adapter = this.domainAdapters.get(goal.domainId);
          if (adapter) {
            try {
              // Apply domain-specific normalizers
              const domainNormalizers = adapter.planNormalizers?.();
              if (domainNormalizers) {
                for (const normalizer of domainNormalizers) {
                  normalizer(normalizedPlan, fixes);
                }
              }
              const validation = adapter.validate(normalizedPlan);
              if (validation.valid) {
                // Only execute echo domain (no side effects); validate-only for others
                if (goal.domainId === 'echo') {
                  const execResult = await adapter.execute(normalizedPlan);
                  result.executionPassed = execResult.success;
                  if (!execResult.success) result.executionError = execResult.error;
                } else {
                  result.executionPassed = true; // validation passed = exec passed for non-echo
                }
              } else {
                result.executionError = validation.errors.join('; ');
              }
            } catch (e) {
              result.executionError = e instanceof Error ? e.message : String(e);
            }
          }
        }
        break;

      } catch {
        result.latencyMs = Date.now() - start;
      }
    }

    return result;
  }

  async runAll(
    goals: EvalGoal[],
    models: EvalModelConfig[],
    llmFactory: (model: EvalModelConfig) => LlmProvider,
  ): Promise<EvalReport> {
    const results: EvalRunResult[] = [];

    for (const model of models) {
      const llm = llmFactory(model);
      for (const goal of goals) {
        const result = await this.runOne(goal, model, llm);
        const status = result.compositionPassed ? '[+]' : '[-]';
        console.log(`  ${status} ${goal.goal.slice(0, 50)}... (${result.latencyMs}ms)`);
        results.push(result);
      }
    }

    // Build summary per model
    const summary = models.map(m => {
      const modelResults = results.filter(r => r.model === m.name);
      const total = modelResults.length || 1;
      return {
        model: m.name,
        jsonRate: modelResults.filter(r => r.jsonValid).length / total,
        planRate: modelResults.filter(r => r.planValid).length / total,
        compositionRate: modelResults.filter(r => r.compositionPassed).length / total,
        executionRate: modelResults.filter(r => r.executionPassed).length / total,
        avgLatencyMs: Math.round(modelResults.reduce((s, r) => s + r.latencyMs, 0) / total),
        avgSteps: +(modelResults.reduce((s, r) => s + r.stepCount, 0) / total).toFixed(1),
      };
    });

    return { timestamp: new Date().toISOString(), goals, results, summary };
  }

  /** Print a formatted report table */
  static printReport(report: EvalReport): void {
    console.log('\n' + '='.repeat(80));
    console.log('CTT-Shell Evaluation Report');
    console.log('='.repeat(80));
    console.log(`Date: ${report.timestamp}`);
    console.log(`Goals: ${report.goals.length}`);
    console.log('');

    // Header
    const header = 'Model'.padEnd(35) + 'JSON%'.padStart(8) + 'Plan%'.padStart(8) + 'Comp%'.padStart(8) + 'Exec%'.padStart(8) + 'Steps'.padStart(8) + 'Latency'.padStart(10);
    console.log(header);
    console.log('-'.repeat(85));

    for (const s of report.summary) {
      const row = s.model.slice(0, 34).padEnd(35)
        + `${Math.round(s.jsonRate * 100)}%`.padStart(8)
        + `${Math.round(s.planRate * 100)}%`.padStart(8)
        + `${Math.round(s.compositionRate * 100)}%`.padStart(8)
        + `${Math.round(s.executionRate * 100)}%`.padStart(8)
        + `${s.avgSteps}`.padStart(8)
        + `${s.avgLatencyMs}ms`.padStart(10);
      console.log(row);
    }
    console.log('');
  }

  /** Print detailed per-goal results */
  static printDetailedReport(report: EvalReport): void {
    console.log('\n' + '='.repeat(80));
    console.log('Detailed Results');
    console.log('='.repeat(80));

    for (const r of report.results) {
      const status = r.compositionPassed ? '[+]' : '[-]';
      console.log(`\n${status} ${r.goal}`);
      console.log(`  Model: ${r.model} | Steps: ${r.stepCount} | Latency: ${r.latencyMs}ms`);
      console.log(`  JSON: ${r.jsonValid ? 'OK' : 'FAIL'} | Plan: ${r.planValid ? 'OK' : 'FAIL'} | Comp: ${r.compositionPassed ? 'OK' : 'FAIL'} | Exec: ${r.executionPassed ? 'OK' : 'FAIL'}`);
      if (r.normalizeFixes.length > 0) {
        console.log(`  Fixes: ${r.normalizeFixes.join(', ')}`);
      }
      if (r.executionError) {
        console.log(`  Exec Error: ${r.executionError}`);
      }
      if (r.rawResponse && !r.jsonValid) {
        console.log(`  Raw: ${r.rawResponse.slice(0, 200)}${r.rawResponse.length > 200 ? '...' : ''}`);
      }
    }
    console.log('');
  }

  /** Save report to disk */
  static saveReport(report: EvalReport, dir: string): string {
    const ts = report.timestamp.replace(/[:.]/g, '-');
    const filename = `${ts}.json`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), JSON.stringify(report, null, 2));
    return filename;
  }

  /** Load a saved report */
  static loadReport(path: string): EvalReport {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  /** Compare current report against a baseline */
  static compareReports(current: EvalReport, baseline: EvalReport): ComparisonResult {
    const deltas: ComparisonDelta[] = [];
    let hasRegressions = false;

    for (const cs of current.summary) {
      const bs = baseline.summary.find(b => b.model === cs.model);
      if (!bs) continue;

      const regressions: string[] = [];
      const jsonDelta = cs.jsonRate - bs.jsonRate;
      const planDelta = cs.planRate - bs.planRate;
      const compDelta = cs.compositionRate - bs.compositionRate;
      const execDelta = cs.executionRate - bs.executionRate;
      const latDelta = cs.avgLatencyMs - bs.avgLatencyMs;

      if (jsonDelta < -0.05) regressions.push(`JSON% dropped ${Math.round(jsonDelta * 100)}pp`);
      if (planDelta < -0.05) regressions.push(`Plan% dropped ${Math.round(planDelta * 100)}pp`);
      if (compDelta < -0.05) regressions.push(`Comp% dropped ${Math.round(compDelta * 100)}pp`);
      if (execDelta < -0.05) regressions.push(`Exec% dropped ${Math.round(execDelta * 100)}pp`);

      if (regressions.length > 0) hasRegressions = true;

      deltas.push({
        model: cs.model,
        jsonRate: jsonDelta,
        planRate: planDelta,
        compositionRate: compDelta,
        executionRate: execDelta,
        latencyDelta: latDelta,
        regressions,
      });
    }

    return { deltas, hasRegressions };
  }

  /** Print comparison table */
  static printComparison(comparison: ComparisonResult): void {
    console.log('\n' + '='.repeat(80));
    console.log('Regression Comparison (vs baseline)');
    console.log('='.repeat(80));

    const header = 'Model'.padEnd(35) + 'JSON%'.padStart(8) + 'Plan%'.padStart(8) + 'Comp%'.padStart(8) + 'Exec%'.padStart(8) + 'Latency'.padStart(10);
    console.log(header);
    console.log('-'.repeat(77));

    for (const d of comparison.deltas) {
      const fmt = (v: number) => {
        const sign = v >= 0 ? '+' : '';
        return `${sign}${Math.round(v * 100)}pp`;
      };
      const row = d.model.slice(0, 34).padEnd(35)
        + fmt(d.jsonRate).padStart(8)
        + fmt(d.planRate).padStart(8)
        + fmt(d.compositionRate).padStart(8)
        + fmt(d.executionRate).padStart(8)
        + `${d.latencyDelta >= 0 ? '+' : ''}${d.latencyDelta}ms`.padStart(10);
      console.log(row);
      if (d.regressions.length > 0) {
        console.log(`  !! ${d.regressions.join(' | ')}`);
      }
    }

    console.log('');
    if (comparison.hasRegressions) {
      console.log('!! REGRESSIONS DETECTED');
    } else {
      console.log('No regressions detected.');
    }
    console.log('');
  }
}

const DEFAULT_EVAL_SYSTEM_PROMPT = `You are an autonomous task composer. Given a goal and available operations, generate an ExecutionPlan JSON.

## Rules
1. Use ONLY operations from the provided context.
2. Set dependsOn when a step needs output from a previous step.
3. Use outputRef to name a step's result, reference it as {{outputRef.field}} in later steps.
4. Be precise and minimal.

## Example
\`\`\`json
{
  "goal": "Create two items and link them",
  "steps": [
    {
      "stepId": 1,
      "description": "Create first item",
      "operationId": "items.create",
      "params": { "name": "Item A" },
      "outputRef": "itemA"
    },
    {
      "stepId": 2,
      "description": "Link to first item",
      "operationId": "items.create",
      "params": { "name": "Item B", "parentId": "{{itemA.id}}" },
      "dependsOn": [1]
    }
  ]
}
\`\`\`

Respond with ONLY the JSON.`;
