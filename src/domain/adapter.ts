/**
 * Domain Adapter Interface
 * Each domain (n8n, WordPress, custom APIs) implements this interface.
 */

import type { Knowledge, ExecutionPlan, ExecutionResult, ValidationResult } from '../types/entities.js';

/** Normalizer function for domain-specific plan fixes */
export type PlanNormalizer = (plan: ExecutionPlan, fixes: string[]) => void;

export interface DomainAdapter {
  /** Unique domain identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Extract Knowledge entities from the domain source */
  extractKnowledge(): Promise<Knowledge[]>;
  /** Execute a planned operation sequence */
  execute(plan: ExecutionPlan): Promise<ExecutionResult>;
  /** Validate a plan before execution */
  validate(plan: ExecutionPlan): ValidationResult;
  /** Domain-specific query expansions for TF-IDF search (optional) */
  queryExpansions?(): Record<string, string[]>;
  /** Domain-specific plan normalizers (optional) */
  planNormalizers?(): PlanNormalizer[];
}
