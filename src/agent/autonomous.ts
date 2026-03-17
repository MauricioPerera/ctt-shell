/**
 * Autonomous Agent — the core CTT pipeline.
 * Chains: recall → plan → normalize → validate → execute → learn.
 */

import type { Store } from '../storage/store.js';
import type { SearchEngine } from '../search/tfidf.js';
import type { DomainRegistry } from '../domain/registry.js';
import type { LlmProvider, LlmMessage } from '../llm/provider.js';
import type { ExecutionPlan, ExecutionResult, AgentEvent, AgentPhase } from '../types/entities.js';
import { CircuitBreaker } from '../guardrails/circuit-breaker.js';
import { normalizeResponse } from '../guardrails/normalize-response.js';
import { normalizePlan } from '../guardrails/normalize-plan.js';
import { recall, contextToPrompt } from './recall.js';
import { learnSkill, learnFromError } from './learn.js';
import { enrichMemory, applyEnrichment } from './enrich.js';

export interface AutonomousAgentConfig {
  store: Store;
  search: SearchEngine;
  domains: DomainRegistry;
  llm: LlmProvider;
  enrichLlm?: LlmProvider;   // optional small local LLM for memory enrichment
  maxRetries?: number;       // default 2
  temperature?: number;      // default 0.1
  compact?: boolean;         // auto-detect from model name
}

export interface AgentRunResult {
  success: boolean;
  plan?: ExecutionPlan;
  result?: ExecutionResult;
  events: AgentEvent[];
  retries: number;
  error?: string;
}

const SYSTEM_PROMPT = `You are an autonomous task composer. Given a goal and available operations, generate an ExecutionPlan JSON.

## Rules
1. Use ONLY operations from the provided context.
2. Set dependsOn when a step needs output from a previous step.
3. Use outputRef to name a step's result, reference it as {{outputRef.field}} in later steps.
4. Be precise and minimal.

## JSON Schema
\`\`\`json
{
  "goal": "What we're doing",
  "steps": [
    {
      "stepId": 1,
      "description": "First operation",
      "operationId": "domain.operation",
      "params": { "key": "value" },
      "outputRef": "result1"
    },
    {
      "stepId": 2,
      "description": "Use previous result",
      "operationId": "domain.operation2",
      "params": { "id": "{{result1.id}}" },
      "dependsOn": [1]
    }
  ]
}
\`\`\`

Respond with ONLY the JSON. No explanations.`;

export class AutonomousAgent {
  private store: Store;
  private search: SearchEngine;
  private domains: DomainRegistry;
  private llm: LlmProvider;
  private enrichLlm?: LlmProvider;
  private circuitBreaker: CircuitBreaker;
  private maxRetries: number;
  private temperature: number;
  private compact: boolean;

  constructor(config: AutonomousAgentConfig) {
    this.store = config.store;
    this.search = config.search;
    this.domains = config.domains;
    this.llm = config.llm;
    this.enrichLlm = config.enrichLlm;
    this.circuitBreaker = new CircuitBreaker(config.store);
    this.maxRetries = config.maxRetries ?? 2;
    this.temperature = config.temperature ?? 0.1;
    this.compact = config.compact ?? false;
  }

  /** Run the full autonomous pipeline */
  async run(goal: string, domainId?: string): Promise<AgentRunResult> {
    const events: AgentEvent[] = [];
    let retries = 0;

    const emit = (phase: AgentPhase, message: string, data?: unknown) => {
      events.push({ phase, timestamp: new Date().toISOString(), message, data });
    };

    try {
      // 1. RECALL
      emit('recall', `Searching context for: ${goal}`);
      const ctx = recall(goal, this.search, this.circuitBreaker, { compact: this.compact });
      emit('recall', `Found ${ctx.knowledge.length} operations, ${ctx.skills.length} skills, ${ctx.antiPatterns.length} anti-patterns`);

      // 2. PLAN (with inline retry on parse failure)
      emit('plan', 'Generating execution plan via LLM');
      let plan: ExecutionPlan | null = null;
      let lastError = '';

      const contextStr = contextToPrompt(ctx, this.compact);
      const messages: LlmMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${contextStr}\n\n## Goal\n${goal}` },
      ];

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const response = await this.llm.chat(messages, {
            temperature: this.temperature,
            maxTokens: 4096,
          });

          const normalized = normalizeResponse(response.content);
          if (!normalized.json) {
            lastError = 'Failed to extract JSON from LLM response';
            // Feed error back for retry
            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: `ERROR: ${lastError}. Respond with valid JSON only.` });
            retries++;
            continue;
          }

          const raw = JSON.parse(normalized.json) as ExecutionPlan;
          if (!raw.goal || !raw.steps || !Array.isArray(raw.steps)) {
            lastError = 'Invalid plan structure: missing goal or steps';
            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: `ERROR: ${lastError}. Include "goal" and "steps" array.` });
            retries++;
            continue;
          }

          plan = raw;
          if (domainId) plan.domainId = domainId;
          break;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          retries++;
        }
      }

      if (!plan) {
        emit('plan', `Failed after ${retries} retries: ${lastError}`);
        return { success: false, events, retries, error: lastError };
      }
      emit('plan', `Plan generated with ${plan.steps.length} steps`);

      // 3. NORMALIZE
      emit('normalize', 'Normalizing plan');
      const { plan: normalizedPlan, fixes } = normalizePlan(plan);

      // Apply domain-specific normalizers
      const targetDomain = domainId || plan.domainId;
      if (targetDomain) {
        const adapter = this.domains.get(targetDomain);
        const domainNormalizers = adapter?.planNormalizers?.();
        if (domainNormalizers) {
          for (const normalizer of domainNormalizers) {
            normalizer(normalizedPlan, fixes);
          }
        }
      }

      if (fixes.length > 0) {
        emit('normalize', `Applied ${fixes.length} fixes: ${fixes.join(', ')}`);
      }

      // 4. VALIDATE
      emit('validate', 'Validating plan');
      const effectiveDomain = targetDomain || this.domains.list()[0];
      if (!effectiveDomain) {
        return { success: false, plan: normalizedPlan, events, retries, error: 'No domain registered' };
      }

      const adapter = this.domains.get(effectiveDomain);
      if (!adapter) {
        return { success: false, plan: normalizedPlan, events, retries, error: `Domain not found: ${effectiveDomain}` };
      }

      const validation = adapter.validate(normalizedPlan);
      if (!validation.valid) {
        emit('validate', `Validation failed: ${validation.errors.join(', ')}`);
        return { success: false, plan: normalizedPlan, events, retries, error: validation.errors.join('; ') };
      }
      emit('validate', 'Plan is valid');

      // 5. EXECUTE
      emit('execute', 'Executing plan');
      const result = await adapter.execute(normalizedPlan);
      emit('execute', result.success ? 'Execution successful' : `Execution failed: ${result.error}`);

      // 6. LEARN
      emit('learn', 'Learning from result');
      if (result.success) {
        const skill = learnSkill(this.store, normalizedPlan, result, effectiveDomain);
        emit('learn', `Saved skill: ${skill.name} (${skill.status})`);
        // Record success for circuit breaker
        for (const step of result.steps) {
          if (step.success) this.circuitBreaker.recordSuccess(step.operationId);
        }
        // Incrementally add new skill to search index
        this.search.addToIndex([skill]);
      } else {
        const memory = learnFromError(this.store, this.circuitBreaker, normalizedPlan, result, effectiveDomain);
        emit('learn', `Saved error memory: ${memory.content.slice(0, 80)}`);

        // Enrich memory with small local LLM (if configured)
        if (this.enrichLlm) {
          try {
            const enrichment = await enrichMemory(this.enrichLlm, memory, { suggestFixes: true });
            applyEnrichment(memory, enrichment);
            this.store.save(memory); // re-save with enriched tags
            emit('learn', `Enriched memory: +${enrichment.tags.length} tags, severity=${enrichment.severity} (${enrichment.enrichDurationMs}ms)`);
          } catch {
            // Enrichment is best-effort, don't fail the pipeline
          }
        }

        // Incrementally add new memory to search index
        this.search.addToIndex([memory]);
      }

      return { success: result.success, plan: normalizedPlan, result, events, retries };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      emit('execute', `Unexpected error: ${error}`);
      return { success: false, events, retries, error };
    }
  }
}
