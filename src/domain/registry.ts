/**
 * Domain Registry — manages registered domains and their adapters.
 */

import type { DomainAdapter } from './adapter.js';
import type { Store } from '../storage/store.js';
import type { SearchEngine } from '../search/tfidf.js';

export class DomainRegistry {
  private domains: Map<string, DomainAdapter> = new Map();
  private store: Store;
  private search: SearchEngine;

  constructor(store: Store, search: SearchEngine) {
    this.store = store;
    this.search = search;
  }

  /** Register a domain adapter */
  register(adapter: DomainAdapter): void {
    this.domains.set(adapter.id, adapter);

    // Inject domain-specific query expansions into search
    const expansions = adapter.queryExpansions?.();
    if (expansions) {
      this.search.addExpansions(expansions);
    }
  }

  /** Get a registered adapter by domain ID */
  get(domainId: string): DomainAdapter | undefined {
    return this.domains.get(domainId);
  }

  /** List all registered domain IDs */
  list(): string[] {
    return [...this.domains.keys()];
  }

  /** Check if a domain is registered */
  has(domainId: string): boolean {
    return this.domains.has(domainId);
  }

  /** Extract and store Knowledge from a domain */
  async extractKnowledge(domainId: string): Promise<number> {
    const adapter = this.domains.get(domainId);
    if (!adapter) throw new Error(`Domain not found: ${domainId}`);

    const knowledge = await adapter.extractKnowledge();
    const saved = this.store.saveBatch(knowledge);

    // Incrementally add new entities instead of full rebuild
    this.search.addToIndex(saved);

    return saved.length;
  }

  /** Rebuild the search index with all stored entities */
  rebuildIndex(): void {
    const allEntities = [
      ...this.store.list('knowledge'),
      ...this.store.list('skill'),
      ...this.store.list('memory'),
    ];
    this.search.index(allEntities);
  }

  /** Get all registered adapters */
  all(): DomainAdapter[] {
    return [...this.domains.values()];
  }
}
