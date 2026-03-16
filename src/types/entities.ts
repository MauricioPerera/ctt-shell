/**
 * CTT-Shell Generic Entity Types
 *
 * Maps RepoMemory v2's CTT primitives to generic domain-agnostic types.
 * Knowledge → operation schemas, Skills → execution patterns,
 * Memories → errors/fixes/learnings, Profiles → connection configs.
 */

// Entity type string literals
export type EntityType = 'knowledge' | 'skill' | 'memory' | 'profile';

export const ENTITY_TYPES: EntityType[] = ['knowledge', 'skill', 'memory', 'profile'];

export interface BaseEntity {
  id: string;
  type: EntityType;
  domainId: string;      // Which domain this belongs to
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

// ─── Knowledge — domain operation schemas ─────────────────────────────────────

export interface KnowledgeParam {
  name: string;
  type: string;          // string, number, boolean, array, object, options
  description: string;
  required: boolean;
  default?: unknown;
  enum?: string[];
}

export interface KnowledgeIO {
  type: string;
  displayName?: string;
  required?: boolean;
}

export interface Knowledge extends BaseEntity {
  type: 'knowledge';
  operationId: string;     // Unique operation identifier within domain
  displayName: string;
  description: string;
  category: string;
  parameters: KnowledgeParam[];
  inputs?: KnowledgeIO[];
  outputs?: KnowledgeIO[];
  credentials?: string[];   // credential type names needed
  metadata?: Record<string, unknown>;  // domain-specific extra data
}

// ─── Skill — proven execution patterns with lifecycle ─────────────────────────

export type SkillStatus = 'experimental' | 'proven' | 'deprecated';

export interface SkillStep {
  stepId: number;
  operationId: string;     // Reference to Knowledge.operationId
  description: string;
  params: Record<string, unknown>;
  dependsOn?: number[];
  outputRef?: string;       // Name to reference this step's output
}

export interface Skill extends BaseEntity {
  type: 'skill';
  name: string;
  description: string;
  goal: string;            // Natural language goal this skill achieves
  useCases: string[];
  steps: SkillStep[];
  status: SkillStatus;
  successCount: number;
  failureCount: number;
}

// ─── Memory — errors, fixes, optimizations from past executions ───────────────

export type MemoryCategory = 'error' | 'fix' | 'optimization' | 'learning';

export interface Memory extends BaseEntity {
  type: 'memory';
  category: MemoryCategory;
  operationId?: string;     // Which operation this relates to
  content: string;          // What happened
  resolution?: string;      // The fix or workaround
  relevance: number;        // 0-1, decays over time
}

// ─── Profile — connection config to an external service ───────────────────────

export interface Profile extends BaseEntity {
  type: 'profile';
  name: string;
  baseUrl?: string;
  credentials: Record<string, string>;  // sanitized placeholders
  metadata?: Record<string, unknown>;
}

// Union type
export type Entity = Knowledge | Skill | Memory | Profile;

// ─── Execution Plan (LLM output) ─────────────────────────────────────────────

export interface ExecutionStep {
  stepId: number;
  description: string;
  operationId: string;      // Which Knowledge operation to invoke
  params: Record<string, unknown>;
  dependsOn?: number[];
  outputRef?: string;        // Name for cross-step references {{ref.field}}
}

export interface ExecutionPlan {
  goal: string;
  domainId?: string;
  steps: ExecutionStep[];
}

// ─── Execution Result ─────────────────────────────────────────────────────────

export interface StepResult {
  stepId: number;
  operationId: string;
  success: boolean;
  response?: unknown;
  error?: string;
  durationMs: number;
}

export interface ExecutionResult {
  success: boolean;
  goal: string;
  domainId?: string;
  steps: StepResult[];
  totalDurationMs: number;
  error?: string;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Agent Events ─────────────────────────────────────────────────────────────

export type AgentPhase = 'recall' | 'plan' | 'normalize' | 'validate' | 'execute' | 'learn';

export interface AgentEvent {
  phase: AgentPhase;
  timestamp: string;
  message: string;
  data?: unknown;
}
