/**
 * Model Evaluator — runs goals against LLM providers and measures metrics.
 */

import type { LlmProvider, LlmMessage } from '../llm/provider.js';
import type { ExecutionPlan } from '../types/entities.js';
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

export class ModelEvaluator {
  private systemPrompt: string;
  private contextGenerator?: (goal: string, compact: boolean) => string;

  constructor(opts?: {
    systemPrompt?: string;
    contextGenerator?: (goal: string, compact: boolean) => string;
  }) {
    this.systemPrompt = opts?.systemPrompt || DEFAULT_EVAL_SYSTEM_PROMPT;
    this.contextGenerator = opts?.contextGenerator;
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
