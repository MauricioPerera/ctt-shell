/**
 * CTT-Shell — Universal AI Agent Framework
 *
 * Combines Agent-Shell execution + CTT memory + a2e guard rails.
 */

// Types
export type {
  EntityType, BaseEntity, Knowledge, KnowledgeParam, KnowledgeIO,
  Skill, SkillStatus, SkillStep, Memory, MemoryCategory, Profile,
  Entity, ExecutionPlan, ExecutionStep, ExecutionResult, StepResult,
  ValidationResult, AgentEvent, AgentPhase,
} from './types/entities.js';

// Storage
export { Store } from './storage/store.js';
export type { StoreConfig } from './storage/store.js';

// Search
export { SearchEngine } from './search/tfidf.js';
export type { SearchResult } from './search/tfidf.js';

// Guard Rails
export { normalizeResponse, extractBestJson } from './guardrails/normalize-response.js';
export { normalizePlan } from './guardrails/normalize-plan.js';
export { CircuitBreaker } from './guardrails/circuit-breaker.js';
export { sanitizeSecrets, resolveSecrets, sanitizeParameters } from './guardrails/sanitize.js';

// Domain
export type { DomainAdapter, PlanNormalizer } from './domain/adapter.js';
export { DomainRegistry } from './domain/registry.js';

// LLM
export { createProvider, ClaudeProvider, OpenAiProvider, OllamaProvider, CloudflareAiProvider } from './llm/provider.js';
export type { LlmProvider, LlmMessage, LlmResponse, LlmOptions, ProviderType } from './llm/provider.js';

// Agent
export { AutonomousAgent } from './agent/autonomous.js';
export type { AutonomousAgentConfig, AgentRunResult } from './agent/autonomous.js';
export { recall, contextToPrompt } from './agent/recall.js';
export type { CTTContext, RecallOptions } from './agent/recall.js';
export { learnSkill, learnFromError, learnFix } from './agent/learn.js';

// Eval
export { ModelEvaluator } from './eval/evaluator.js';
export type { EvalGoal, EvalModelConfig, EvalRunResult, EvalReport } from './eval/evaluator.js';

// Shell Engine
export { ShellExecutor, createExecutor } from './shell/executor.js';
export type { ExecutorConfig, ShellResult } from './shell/executor.js';
export { POLICIES, validateCommand } from './shell/policy.js';
export type { ShellPolicy, ShellRole } from './shell/policy.js';
export { parseCommand, flattenPipeline, commandToString } from './shell/parser.js';
export type { ShellCommand, ParseResult } from './shell/parser.js';
export { AuditLog } from './shell/audit.js';
export type { AuditEntry } from './shell/audit.js';

// Context
export { ContextLoader } from './context/loader.js';
export type { ContextEntry } from './context/loader.js';

// MCP
export { McpServer, startMcpServer } from './mcp/server.js';
