/**
 * Embedding Search — semantic search using pluggable embedding providers.
 * Uses Matryoshka Representation Learning (MRL) for cascaded search:
 *   Stage 1: 128d — fast coarse filter (eliminates ~80% of candidates)
 *   Stage 2: 256d — medium re-rank (narrows to top candidates)
 *   Stage 3: 768d — full precision final ranking
 *
 * Providers: Ollama, Cloudflare Workers AI, OpenAI-compatible (llamacpp, vLLM, LiteLLM).
 * Optional disk cache eliminates re-embedding on restart.
 * Zero runtime dependencies — uses native fetch.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Entity, Knowledge, Skill, Memory, Profile } from '../types/entities.js';
import type { SearchResult } from './tfidf.js';

// ─── Embedding Provider Interface ────────────────────────────────────────────

export interface EmbeddingProvider {
  readonly name: string;
  /** Generate embeddings for an array of texts. Returns one vector per text. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Check if the provider is reachable / model is available */
  isAvailable(): Promise<boolean>;
  /** Dimensionality of output vectors (0 = unknown until first call) */
  readonly dimensions: number;
}

// ─── Ollama Provider ─────────────────────────────────────────────────────────

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private baseUrl: string;
  private model: string;
  private batchSize: number;

  constructor(config: { baseUrl?: string; model?: string; batchSize?: number; dimensions?: number } = {}) {
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';
    this.model = config.model ?? 'embeddinggemma';
    this.batchSize = config.batchSize ?? 32;
    this.dimensions = config.dimensions ?? 768;
    this.name = `ollama:${this.model}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: 'test' }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (!res.ok) throw new Error(`Ollama embed error (${res.status}): ${await res.text()}`);
      const data = await res.json() as { embeddings: number[][] };
      for (const vec of data.embeddings) vectors.push(new Float32Array(vec));
    }
    return vectors;
  }
}

// ─── Cloudflare Workers AI Provider ──────────────────────────────────────────

export class CloudflareEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private apiKey: string;
  private accountId: string;
  private model: string;
  private gateway?: string;
  private batchSize: number;

  constructor(config: { apiKey: string; accountId: string; model?: string; gateway?: string; batchSize?: number; dimensions?: number }) {
    this.apiKey = config.apiKey;
    this.accountId = config.accountId;
    this.model = config.model ?? '@cf/baai/bge-base-en-v1.5';
    this.gateway = config.gateway;
    this.batchSize = config.batchSize ?? 32;
    this.dimensions = config.dimensions ?? 768;
    this.name = `cf:${this.model}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = this.buildUrl();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ['test'] }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    const url = this.buildUrl();
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: batch }),
      });
      if (!res.ok) throw new Error(`CF embed error (${res.status}): ${await res.text()}`);
      const data = await res.json() as { result: { data: number[][] } };
      for (const vec of data.result.data) vectors.push(new Float32Array(vec));
    }
    return vectors;
  }

  private buildUrl(): string {
    if (this.gateway) {
      return `https://gateway.ai.cloudflare.com/v1/${this.accountId}/${this.gateway}/workers-ai/${this.model}`;
    }
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;
  }
}

// ─── OpenAI-Compatible Provider (llamacpp, vLLM, LiteLLM, OpenAI) ───────────

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private batchSize: number;

  constructor(config: { baseUrl?: string; model?: string; apiKey?: string; batchSize?: number; dimensions?: number } = {}) {
    this.baseUrl = config.baseUrl ?? 'http://localhost:8080';
    this.model = config.model ?? 'text-embedding-3-small';
    this.apiKey = config.apiKey ?? '';
    this.batchSize = config.batchSize ?? 32;
    this.dimensions = config.dimensions ?? 1536;
    this.name = `openai:${this.model}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.model, input: ['test'] }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (!res.ok) throw new Error(`OpenAI embed error (${res.status}): ${await res.text()}`);
      const data = await res.json() as { data: { embedding: number[] }[] };
      // OpenAI returns sorted by index
      const sorted = data.data.sort((a: any, b: any) => a.index - b.index);
      for (const item of sorted) vectors.push(new Float32Array(item.embedding));
    }
    return vectors;
  }
}

// ─── Embedding Cache ─────────────────────────────────────────────────────────

interface CacheEntry {
  text: string;
  vector: number[];
}

interface CacheFile {
  provider: string;
  dimensions: number;
  entries: Record<string, CacheEntry>;  // SHA-256(text) → {text, vector}
}

class EmbeddingCache {
  private entries: Map<string, Float32Array> = new Map();
  private dirty = false;
  private cacheDir: string;
  private providerName: string;

  constructor(cacheDir: string, providerName: string) {
    this.cacheDir = cacheDir;
    this.providerName = providerName;
    this.load();
  }

  /** Get cached vector for text, or undefined */
  get(text: string): Float32Array | undefined {
    return this.entries.get(this.hash(text));
  }

  /** Store vector for text */
  set(text: string, vector: Float32Array): void {
    this.entries.set(this.hash(text), vector);
    this.dirty = true;
  }

  /** Persist cache to disk (only if dirty) */
  save(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const file: CacheFile = {
        provider: this.providerName,
        dimensions: this.entries.size > 0 ? [...this.entries.values()][0].length : 0,
        entries: {},
      };
      for (const [hash, vector] of this.entries) {
        file.entries[hash] = { text: '', vector: Array.from(vector) };
      }
      writeFileSync(this.cachePath(), JSON.stringify(file));
      this.dirty = false;
    } catch {
      // Best effort — cache is optional
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private load(): void {
    try {
      const path = this.cachePath();
      if (!existsSync(path)) return;
      const data = JSON.parse(readFileSync(path, 'utf-8')) as CacheFile;
      if (data.provider !== this.providerName) return; // Different provider, ignore
      for (const [hash, entry] of Object.entries(data.entries)) {
        this.entries.set(hash, new Float32Array(entry.vector));
      }
    } catch {
      // Corrupted cache, start fresh
    }
  }

  private hash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  }

  private cachePath(): string {
    // Sanitize provider name for filesystem
    const safe = this.providerName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.cacheDir, `embeddings-${safe}.json`);
  }
}

// ─── Matryoshka Cascade Search ───────────────────────────────────────────────

// Matryoshka dimension tiers
const MRL_DIMS = [128, 256, 768] as const;

interface EmbeddedDoc {
  id: string;
  entity: Entity;
  text: string;
  vector: Float32Array;
}

/** Dot product for L2-normalized vectors (= cosine similarity) */
function dotProduct(a: Float32Array, b: Float32Array, dims?: number): number {
  const len = dims ?? a.length;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

/** L2-normalize a vector (or a truncated prefix of it) */
function l2Normalize(vec: Float32Array, dims?: number): Float32Array {
  const len = dims ?? vec.length;
  const result = new Float32Array(len);
  let norm = 0;
  for (let i = 0; i < len; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return result;
  for (let i = 0; i < len; i++) result[i] = vec[i] / norm;
  return result;
}

/** Convert entity to text for embedding */
function entityToText(entity: Entity): string {
  switch (entity.type) {
    case 'knowledge': {
      const k = entity as Knowledge;
      const params = k.parameters.map(p => `${p.name}: ${p.description}`).join(', ');
      return `${k.displayName} - ${k.description}. Parameters: ${params}`;
    }
    case 'skill': {
      const s = entity as Skill;
      return `${s.name} - ${s.description}. Goal: ${s.goal}`;
    }
    case 'memory': {
      const m = entity as Memory;
      return `${m.category}: ${m.content}${m.resolution ? `. Fix: ${m.resolution}` : ''}`;
    }
    case 'profile': {
      const p = entity as Profile;
      return `${p.name} at ${p.baseUrl ?? 'unknown'}`;
    }
    default:
      return '';
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface EmbeddingConfig {
  /** Pre-built embedding provider (takes precedence over legacy fields) */
  provider?: EmbeddingProvider;

  /** Cache directory for persisted embeddings (default: .ctt-shell/cache) */
  cacheDir?: string;

  /** Enable Matryoshka cascade search (default: true) */
  cascade?: boolean;

  // Legacy fields (used when provider is not specified — creates OllamaEmbeddingProvider)
  baseUrl?: string;     // default: http://localhost:11434
  model?: string;       // default: embeddinggemma
  batchSize?: number;   // default: 32
}

// ─── EmbeddingSearch Class ───────────────────────────────────────────────────

export class EmbeddingSearch {
  private docs: EmbeddedDoc[] = [];
  private mrlVectors: Map<number, Float32Array[]> = new Map();
  private provider: EmbeddingProvider;
  private cascade: boolean;
  private cache?: EmbeddingCache;
  private fullDims: number;

  constructor(config: EmbeddingConfig = {}) {
    this.provider = config.provider ?? new OllamaEmbeddingProvider({
      baseUrl: config.baseUrl,
      model: config.model,
      batchSize: config.batchSize,
    });
    this.cascade = config.cascade ?? true;
    this.fullDims = this.provider.dimensions || 768;

    if (config.cacheDir) {
      this.cache = new EmbeddingCache(config.cacheDir, this.provider.name);
    }
  }

  /** Check if the embedding provider is available */
  async isAvailable(): Promise<boolean> {
    return this.provider.isAvailable();
  }

  /** Provider name for diagnostics */
  get providerName(): string {
    return this.provider.name;
  }

  /** Generate embeddings with cache support */
  private async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.cache) {
      return this.provider.embed(texts);
    }

    // Check cache, collect misses
    const results: (Float32Array | null)[] = texts.map(t => this.cache!.get(t) ?? null);
    const misses: { index: number; text: string }[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) misses.push({ index: i, text: texts[i] });
    }

    // Embed only cache misses
    if (misses.length > 0) {
      const missTexts = misses.map(m => m.text);
      const missVectors = await this.provider.embed(missTexts);
      for (let i = 0; i < misses.length; i++) {
        results[misses[i].index] = missVectors[i];
        this.cache!.set(misses[i].text, missVectors[i]);
      }
      this.cache!.save();
    }

    return results as Float32Array[];
  }

  /** Pre-compute normalized MRL vectors for cascade search */
  private buildMrlIndex(): void {
    const dims = this.cascadeDims();
    for (const d of dims) {
      const normalized = this.docs.map(doc => l2Normalize(doc.vector, d));
      this.mrlVectors.set(d, normalized);
    }
  }

  /** Get cascade dimension tiers, capped to actual vector dimensions */
  private cascadeDims(): number[] {
    return MRL_DIMS.filter(d => d <= this.fullDims);
  }

  /** Build the embedding index from entities */
  async index(entities: Entity[]): Promise<void> {
    if (entities.length === 0) return;

    const texts = entities.map(entityToText);
    const vectors = await this.embed(texts);

    this.docs = entities.map((entity, i) => ({
      id: entity.id,
      entity,
      text: texts[i],
      vector: vectors[i],
    }));

    // Auto-detect dimensions from first vector
    if (vectors.length > 0) this.fullDims = vectors[0].length;

    if (this.cascade) this.buildMrlIndex();
  }

  /** Incrementally add entities to the index */
  async addToIndex(entities: Entity[]): Promise<void> {
    const newEntities = entities.filter(e => !this.docs.some(d => d.id === e.id));
    if (newEntities.length === 0) return;

    const texts = newEntities.map(entityToText);
    const vectors = await this.embed(texts);

    for (let i = 0; i < newEntities.length; i++) {
      this.docs.push({
        id: newEntities[i].id,
        entity: newEntities[i],
        text: texts[i],
        vector: vectors[i],
      });
    }

    if (this.cascade) this.buildMrlIndex();
  }

  /**
   * Search with Matryoshka cascade:
   * 1. Score ALL docs at tier1 → keep top 4x limit
   * 2. Re-score at tier2 → keep top 2x limit
   * 3. Re-score at full dims → return top limit
   */
  async search(query: string, limit = 20): Promise<SearchResult[]> {
    if (this.docs.length === 0) return [];

    const [queryFull] = await this.embed([query]);
    const dims = this.cascadeDims();

    if (!this.cascade || dims.length < 2 || this.docs.length < limit * 4) {
      return this.linearSearch(queryFull, limit);
    }

    // Stage 1: coarse filter at smallest dimension
    const d1 = dims[0];
    const queryNorm1 = l2Normalize(queryFull, d1);
    const vecs1 = this.mrlVectors.get(d1)!;
    const stage1Limit = Math.min(limit * 4, this.docs.length);
    const stage1 = this.topK(queryNorm1, vecs1, d1, stage1Limit);

    // Stage 2: medium re-rank (use middle tier if 3+ tiers, else skip)
    let candidates = stage1;
    if (dims.length >= 3) {
      const d2 = dims[1];
      const queryNorm2 = l2Normalize(queryFull, d2);
      const vecs2 = this.mrlVectors.get(d2)!;
      const stage2Limit = Math.min(limit * 2, candidates.length);
      candidates = this.topKFromCandidates(queryNorm2, vecs2, d2, candidates, stage2Limit);
    }

    // Stage 3: full precision final rank
    const dFull = dims[dims.length - 1];
    const queryNormFull = l2Normalize(queryFull, dFull);
    const vecsFull = this.mrlVectors.get(dFull)!;
    const final = this.topKFromCandidates(queryNormFull, vecsFull, dFull, candidates, limit);

    return final.map(({ idx, score }) => ({
      entity: this.docs[idx].entity,
      score,
      matchedTerms: [],
    }));
  }

  /** Linear search over all docs at full dimensionality */
  private linearSearch(queryVec: Float32Array, limit: number): SearchResult[] {
    const d = this.fullDims;
    const queryNorm = l2Normalize(queryVec, d);
    const scored: { entity: Entity; score: number }[] = [];

    for (const doc of this.docs) {
      const docNorm = l2Normalize(doc.vector, d);
      const similarity = dotProduct(queryNorm, docNorm, d);
      if (similarity > 0) {
        scored.push({ entity: doc.entity, score: similarity });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => ({ entity: r.entity, score: r.score, matchedTerms: [] }));
  }

  /** Top-K over all docs at a given dimension */
  private topK(queryNorm: Float32Array, docVecs: Float32Array[], dims: number, k: number): { idx: number; score: number }[] {
    const scored: { idx: number; score: number }[] = [];
    for (let i = 0; i < docVecs.length; i++) {
      const score = dotProduct(queryNorm, docVecs[i], dims);
      scored.push({ idx: i, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  /** Top-K from a subset of candidate indices */
  private topKFromCandidates(
    queryNorm: Float32Array,
    docVecs: Float32Array[],
    dims: number,
    candidates: { idx: number }[],
    k: number,
  ): { idx: number; score: number }[] {
    const scored: { idx: number; score: number }[] = [];
    for (const { idx } of candidates) {
      const score = dotProduct(queryNorm, docVecs[idx], dims);
      scored.push({ idx, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  /** Get indexed document count */
  get size(): number {
    return this.docs.length;
  }

  /** Get cache hit count */
  get cacheSize(): number {
    return this.cache?.size ?? 0;
  }
}

// ─── Provider Factory ────────────────────────────────────────────────────────

export type EmbeddingProviderType = 'ollama' | 'cloudflare' | 'openai';

export function createEmbeddingProvider(
  type: EmbeddingProviderType,
  config?: Record<string, unknown>,
): EmbeddingProvider {
  switch (type) {
    case 'ollama':
      return new OllamaEmbeddingProvider({
        baseUrl: config?.baseUrl as string,
        model: config?.model as string,
        batchSize: config?.batchSize as number,
        dimensions: config?.dimensions as number,
      });
    case 'cloudflare':
      return new CloudflareEmbeddingProvider({
        apiKey: (config?.apiKey as string) ?? process.env.CF_API_KEY ?? '',
        accountId: (config?.accountId as string) ?? process.env.CF_ACCOUNT_ID ?? '',
        model: config?.model as string,
        gateway: config?.gateway as string,
        batchSize: config?.batchSize as number,
        dimensions: config?.dimensions as number,
      });
    case 'openai':
      return new OpenAiEmbeddingProvider({
        baseUrl: config?.baseUrl as string,
        model: config?.model as string,
        apiKey: (config?.apiKey as string) ?? process.env.OPENAI_API_KEY,
        batchSize: config?.batchSize as number,
        dimensions: config?.dimensions as number,
      });
    default:
      throw new Error(`Unknown embedding provider: ${type}`);
  }
}

// ─── Hybrid Search (RRF) ────────────────────────────────────────────────────

/**
 * Hybrid search: combines TF-IDF and embedding results with Reciprocal Rank Fusion (RRF).
 * TF-IDF provides exact keyword matching, embeddings provide semantic understanding.
 */
export function hybridSearch(
  tfidfResults: SearchResult[],
  embeddingResults: SearchResult[],
  limit = 20,
  tfidfWeight = 0.4,
  embeddingWeight = 0.6,
): SearchResult[] {
  const k = 60; // RRF constant
  const scores = new Map<string, { entity: Entity; score: number; matchedTerms: string[] }>();

  for (let i = 0; i < tfidfResults.length; i++) {
    const id = tfidfResults[i].entity.id;
    const rrfScore = tfidfWeight / (k + i + 1);
    scores.set(id, {
      entity: tfidfResults[i].entity,
      score: rrfScore,
      matchedTerms: tfidfResults[i].matchedTerms,
    });
  }

  for (let i = 0; i < embeddingResults.length; i++) {
    const id = embeddingResults[i].entity.id;
    const rrfScore = embeddingWeight / (k + i + 1);
    const existing = scores.get(id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(id, {
        entity: embeddingResults[i].entity,
        score: rrfScore,
        matchedTerms: [],
      });
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
