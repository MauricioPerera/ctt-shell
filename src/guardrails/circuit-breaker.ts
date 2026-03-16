/**
 * Circuit Breaker
 *
 * Prevents the autonomous agent from repeatedly failing on the same
 * operation types or API endpoints. Adapted from n8n-a2e's circuit-breaker.
 *
 * Tracks error counts per operationId or host. When errors exceed a threshold,
 * the circuit "opens" and the agent skips that operation/host.
 *
 * Enhanced: Stores error reasons and resolutions, providing WHY context
 * to the LLM when requesting alternatives.
 */

import { Store } from '../storage/store.js';
import type { Memory } from '../types/entities.js';

export interface CircuitBreakerResult {
  open: boolean;
  errorCount: number;
  target: string;
  message: string;
  /** Most recent error reasons for this target */
  reasons: string[];
  /** Known resolutions for this target */
  resolutions: string[];
}

const DEFAULT_THRESHOLD = 3;

export class CircuitBreaker {
  private store: Store;
  private threshold: number;
  /** In-memory cache to avoid repeated disk reads within a session */
  private errorCounts: Map<string, number> = new Map();
  /** Error reasons per target (most recent first) */
  private errorReasons: Map<string, string[]> = new Map();
  /** Known resolutions per target */
  private knownResolutions: Map<string, string[]> = new Map();
  private loaded = false;

  constructor(store: Store, threshold = DEFAULT_THRESHOLD) {
    this.store = store;
    this.threshold = threshold;
  }

  /** Load error counts and reasons from stored Memory entities */
  private loadIfNeeded(): void {
    if (this.loaded) return;
    const memories = this.store.list<Memory>('memory');
    for (const mem of memories) {
      if (mem.category === 'error') {
        const key = mem.operationId || 'unknown';
        this.errorCounts.set(key, (this.errorCounts.get(key) ?? 0) + 1);
        if (mem.content) {
          const reasons = this.errorReasons.get(key) ?? [];
          reasons.push(mem.content);
          this.errorReasons.set(key, reasons);
        }
        if (mem.resolution) {
          const resolutions = this.knownResolutions.get(key) ?? [];
          if (!resolutions.includes(mem.resolution)) {
            resolutions.push(mem.resolution);
          }
          this.knownResolutions.set(key, resolutions);
        }
      } else if (mem.category === 'fix') {
        const key = mem.operationId || 'unknown';
        if (mem.resolution) {
          const resolutions = this.knownResolutions.get(key) ?? [];
          if (!resolutions.includes(mem.resolution)) {
            resolutions.push(mem.resolution);
          }
          this.knownResolutions.set(key, resolutions);
        }
      }
    }
    this.loaded = true;
  }

  /** Check if an operation type or host is blocked */
  check(target: string): CircuitBreakerResult {
    this.loadIfNeeded();
    const count = this.errorCounts.get(target) ?? 0;
    const open = count >= this.threshold;
    const reasons = (this.errorReasons.get(target) ?? []).slice(-3); // last 3 reasons
    const resolutions = this.knownResolutions.get(target) ?? [];

    let message: string;
    if (open) {
      message = `Circuit OPEN for "${target}" (${count} errors, threshold: ${this.threshold}).`;
      if (reasons.length > 0) {
        message += ` Reasons: ${reasons.map(r => r.slice(0, 80)).join('; ')}`;
      }
    } else {
      message = `Circuit closed for "${target}" (${count}/${this.threshold} errors).`;
    }

    return { open, errorCount: count, target, message, reasons, resolutions };
  }

  /** Record an error for a target */
  recordError(target: string, content: string, resolution?: string): void {
    this.loadIfNeeded();
    this.errorCounts.set(target, (this.errorCounts.get(target) ?? 0) + 1);

    // Track reasons in memory
    if (content) {
      const reasons = this.errorReasons.get(target) ?? [];
      reasons.push(content);
      this.errorReasons.set(target, reasons);
    }
    if (resolution) {
      const resolutions = this.knownResolutions.get(target) ?? [];
      if (!resolutions.includes(resolution)) {
        resolutions.push(resolution);
      }
      this.knownResolutions.set(target, resolutions);
    }

    const mem: Memory = {
      id: '',
      type: 'memory',
      domainId: '',
      createdAt: '',
      updatedAt: '',
      tags: ['ctt-error', target],
      category: 'error',
      operationId: target,
      content,
      resolution,
      relevance: 1.0,
    };
    this.store.save(mem);
  }

  /** Record a success — resets the error count for a target */
  recordSuccess(target: string): void {
    this.loadIfNeeded();
    this.errorCounts.set(target, 0);
  }

  /** Extract host from a URL string */
  static extractHost(url: string): string | null {
    const match = url.match(/^https?:\/\/([^/:]+)/);
    return match ? match[1] : null;
  }

  /** Check all operation IDs in a plan, return blocked ones */
  checkPlan(operationIds: string[]): CircuitBreakerResult[] {
    return operationIds
      .map(t => this.check(t))
      .filter(r => r.open);
  }

  /**
   * Get all known anti-patterns: errors and fixes that should be communicated to the LLM.
   * Returns deduplicated entries, most recent first, limited to maxItems.
   */
  getAntiPatterns(maxItems = 10): { target: string; error: string; resolution?: string }[] {
    this.loadIfNeeded();
    const patterns: { target: string; error: string; resolution?: string }[] = [];
    const seen = new Set<string>();

    for (const [target, reasons] of this.errorReasons.entries()) {
      const resolutions = this.knownResolutions.get(target) ?? [];
      for (const reason of reasons.slice(-3)) {
        const key = `${target}:${reason.slice(0, 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        patterns.push({
          target,
          error: reason,
          resolution: resolutions[0],
        });
      }
    }

    // Also include fix-only entries (no error, just learned resolutions)
    for (const [target, resolutions] of this.knownResolutions.entries()) {
      if (!this.errorReasons.has(target)) {
        for (const res of resolutions) {
          const key = `fix:${target}:${res.slice(0, 50)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          patterns.push({ target, error: 'Known pitfall', resolution: res });
        }
      }
    }

    return patterns.slice(-maxItems);
  }
}
