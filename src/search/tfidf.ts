/**
 * TF-IDF Search Engine for CTT entities
 * Zero dependencies, Porter stemming, configurable query expansion.
 */

import type { Entity, Knowledge, Skill, Memory, Profile } from '../types/entities.js';

// ─── Porter Stemmer (simplified) ─────────────────────────────────────────────

const STEP2_SUFFIXES: [string, string][] = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
  ['izer', 'ize'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'],
  ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'],
  ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'], ['ousness', 'ous'],
  ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
];

function stem(word: string): string {
  if (word.length < 3) return word;
  let w = word.toLowerCase();

  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (!w.endsWith('ss') && w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b (simplified)
  if (w.endsWith('eed')) {
    w = w.slice(0, -1);
  } else if (w.endsWith('ed') && /[aeiou]/.test(w.slice(0, -2))) {
    w = w.slice(0, -2);
  } else if (w.endsWith('ing') && /[aeiou]/.test(w.slice(0, -3))) {
    w = w.slice(0, -3);
  }

  // Step 2 (simplified)
  for (const [suffix, replacement] of STEP2_SUFFIXES) {
    if (w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length) + replacement;
      break;
    }
  }

  return w;
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'and', 'or', 'but', 'if',
  'then', 'else', 'when', 'at', 'by', 'for', 'with', 'about', 'against',
  'between', 'through', 'during', 'before', 'after', 'above', 'below',
  'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
  'of', 'no', 'not', 'this', 'that', 'these', 'those', 'it', 'its',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .map(stem);
}

// ─── Query Expansion ─────────────────────────────────────────────────────────

// Empty by default — domains inject their own via setExpansions / addExpansions
let expansions: Record<string, string[]> = {};

function expandQuery(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    const synonyms = expansions[token];
    if (synonyms) {
      for (const s of synonyms) expanded.add(s);
    }
  }
  return [...expanded];
}

// ─── TF-IDF Index ────────────────────────────────────────────────────────────

interface IndexedDoc {
  id: string;
  entity: Entity;
  tokens: string[];
  tf: Map<string, number>;
}

export interface SearchResult {
  entity: Entity;
  score: number;
  matchedTerms: string[];
}

export class SearchEngine {
  private docs: IndexedDoc[] = [];
  private df: Map<string, number> = new Map();
  private totalDocs = 0;

  /** Replace all query expansions (pre-stems values) */
  setExpansions(newExpansions: Record<string, string[]>): void {
    expansions = {};
    for (const [key, values] of Object.entries(newExpansions)) {
      expansions[key] = values.map(v => stem(v.toLowerCase()));
    }
  }

  /** Merge additional expansions into the existing set (pre-stems values) */
  addExpansions(extra: Record<string, string[]>): void {
    for (const [key, values] of Object.entries(extra)) {
      const stemmed = values.map(v => stem(v.toLowerCase()));
      if (expansions[key]) {
        const merged = new Set([...expansions[key], ...stemmed]);
        expansions[key] = [...merged];
      } else {
        expansions[key] = [...stemmed];
      }
    }
  }

  /** Build the index from entities */
  index(entities: Entity[]): void {
    this.docs = [];
    this.df = new Map();
    this.totalDocs = entities.length;

    for (const entity of entities) {
      const text = this.entityToText(entity);
      const tokens = tokenize(text);
      const tf = new Map<string, number>();

      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }

      // Normalize TF
      const maxTf = Math.max(...tf.values(), 1);
      for (const [term, count] of tf) {
        tf.set(term, count / maxTf);
      }

      // Update document frequency
      const uniqueTerms = new Set(tokens);
      for (const term of uniqueTerms) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }

      this.docs.push({ id: entity.id, entity, tokens, tf });
    }
  }

  /** Incrementally add entities to the index without full rebuild */
  addToIndex(entities: Entity[]): void {
    for (const entity of entities) {
      if (this.docs.some(d => d.id === entity.id)) continue;

      const text = this.entityToText(entity);
      const tokens = tokenize(text);
      const tf = new Map<string, number>();

      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }

      const maxTf = Math.max(...tf.values(), 1);
      for (const [term, count] of tf) {
        tf.set(term, count / maxTf);
      }

      const uniqueTerms = new Set(tokens);
      for (const term of uniqueTerms) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }

      this.docs.push({ id: entity.id, entity, tokens, tf });
      this.totalDocs++;
    }
  }

  /** Search for entities matching a query */
  search(query: string, limit = 20): SearchResult[] {
    const queryTokens = tokenize(query);
    const expanded = expandQuery(queryTokens);

    const results: SearchResult[] = [];

    for (const doc of this.docs) {
      let score = 0;
      const matched: string[] = [];

      for (const term of expanded) {
        const tf = doc.tf.get(term) ?? 0;
        if (tf === 0) continue;

        const df = this.df.get(term) ?? 0;
        const idf = Math.log((this.totalDocs + 1) / (df + 1)) + 1;
        score += tf * idf;
        matched.push(term);
      }

      // Boost: tag overlap (Set for O(1) lookup)
      const entity = doc.entity;
      if ('tags' in entity && Array.isArray(entity.tags)) {
        const tagSet = new Set(entity.tags.map(t => stem(t.toLowerCase())));
        for (const term of expanded) {
          if (tagSet.has(term)) score *= 1.3;
        }
      }

      if (score > 0) {
        results.push({ entity: doc.entity, score, matchedTerms: matched });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Convert entity to searchable text based on its type */
  private entityToText(entity: Entity): string {
    switch (entity.type) {
      case 'knowledge': {
        const k = entity as Knowledge;
        const paramText = k.parameters.map(p => `${p.name} ${p.description}`).join(' ');
        const credText = (k.credentials ?? []).join(' ');
        return `${k.displayName} ${k.operationId} ${k.description} ${k.category} ${paramText} ${credText} ${k.tags.join(' ')}`;
      }
      case 'skill': {
        const s = entity as Skill;
        const stepText = s.steps.map(st => `${st.operationId} ${st.description}`).join(' ');
        return `${s.name} ${s.description} ${s.goal} ${s.useCases.join(' ')} ${stepText} ${s.tags.join(' ')}`;
      }
      case 'memory': {
        const m = entity as Memory;
        return `${m.category} ${m.operationId ?? ''} ${m.content} ${m.resolution ?? ''} ${m.tags.join(' ')}`;
      }
      case 'profile': {
        const p = entity as Profile;
        return `${p.name} ${p.baseUrl ?? ''} ${p.tags.join(' ')}`;
      }
      default:
        return '';
    }
  }
}
