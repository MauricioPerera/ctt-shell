/**
 * Memory Enrichment — uses a small local LLM to classify and tag memories.
 * Designed for ultra-small models (135M-270M) with simple single-task prompts.
 * Runs 3 parallel classifications per memory: category, tags, severity.
 */

import type { LlmProvider } from '../llm/provider.js';
import type { Memory, MemoryCategory } from '../types/entities.js';

export interface EnrichmentResult {
  category: MemoryCategory;
  tags: string[];
  severity: 'blocking' | 'recoverable' | 'warning';
  suggestedFix?: string;
  enrichedBy: string; // model name
  enrichDurationMs: number;
}

const VALID_CATEGORIES: MemoryCategory[] = ['error', 'fix', 'optimization', 'learning'];
const CATEGORY_MAP: Record<string, MemoryCategory> = {
  timeout: 'error',
  auth: 'error',
  validation: 'error',
  not_found: 'error',
  parse: 'error',
  rate_limit: 'error',
  connection: 'error',
  permission: 'error',
  unknown: 'error',
  fix: 'fix',
  optimization: 'optimization',
  learning: 'learning',
};

const SEVERITY_MAP: Record<string, 'blocking' | 'recoverable' | 'warning'> = {
  blocking: 'blocking',
  recoverable: 'recoverable',
  warning: 'warning',
};

/** Classify an error into a sub-category (auth, timeout, validation, etc.) */
async function classifyError(llm: LlmProvider, errorText: string): Promise<string> {
  const content = `Error: "${errorText.slice(0, 200)}"
Category (one word): timeout|auth|validation|not_found|parse|rate_limit|connection|permission|unknown
Answer:`;

  try {
    const res = await llm.chat(
      [{ role: 'user', content }],
      { temperature: 0.1, maxTokens: 10 },
    );
    const word = res.content.trim().toLowerCase().split(/[\s,.\n]/)[0];
    return word || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Extract relevant tags from an error */
async function extractTags(llm: LlmProvider, errorText: string): Promise<string[]> {
  const content = `Error: "${errorText.slice(0, 200)}"
List 3-5 relevant tags (comma separated, lowercase, no spaces):
Tags:`;

  try {
    const res = await llm.chat(
      [{ role: 'user', content }],
      { temperature: 0.1, maxTokens: 30 },
    );
    const raw = res.content.trim().toLowerCase();
    const tags = raw.split(',')
      .map(t => t.trim().replace(/[^a-z0-9_-]/g, ''))
      .filter(t => t.length > 0 && t.length < 30);
    return tags.slice(0, 5);
  } catch {
    return [];
  }
}

/** Determine error severity */
async function classifySeverity(llm: LlmProvider, errorText: string): Promise<'blocking' | 'recoverable' | 'warning'> {
  const content = `Error: "${errorText.slice(0, 200)}"
Severity: blocking|recoverable|warning
Answer:`;

  try {
    const res = await llm.chat(
      [{ role: 'user', content }],
      { temperature: 0.1, maxTokens: 5 },
    );
    const word = res.content.trim().toLowerCase().split(/[\s,.\n]/)[0];
    return SEVERITY_MAP[word] ?? 'blocking';
  } catch {
    return 'blocking';
  }
}

/** Suggest a fix for the error */
async function suggestFix(llm: LlmProvider, errorText: string): Promise<string | undefined> {
  const content = `Error: "${errorText.slice(0, 200)}"
One-line fix suggestion (10 words max):`;

  try {
    const res = await llm.chat(
      [{ role: 'user', content }],
      { temperature: 0.3, maxTokens: 30 },
    );
    const fix = res.content.trim().split('\n')[0].slice(0, 100);
    return fix.length > 3 ? fix : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Enrich a memory entity with LLM-generated metadata.
 * Runs classify, tags, and severity in parallel for speed.
 * Optionally generates a fix suggestion (4th call).
 */
export async function enrichMemory(
  llm: LlmProvider,
  memory: Memory,
  options: { suggestFixes?: boolean } = {},
): Promise<EnrichmentResult> {
  const start = Date.now();
  const errorText = memory.content;

  // Run 3 (or 4) classifications in parallel
  const tasks: [Promise<string>, Promise<string[]>, Promise<'blocking' | 'recoverable' | 'warning'>, Promise<string | undefined>?] = [
    classifyError(llm, errorText),
    extractTags(llm, errorText),
    classifySeverity(llm, errorText),
  ];

  if (options.suggestFixes) {
    tasks.push(suggestFix(llm, errorText));
  }

  const results = await Promise.all(tasks);

  const subCategory = results[0] as string;
  const tags = results[1] as string[];
  const severity = results[2] as 'blocking' | 'recoverable' | 'warning';
  const fix = results[3] as string | undefined;

  // Map sub-category to MemoryCategory
  const category = CATEGORY_MAP[subCategory] ?? memory.category;

  return {
    category,
    tags: [...new Set([...tags, subCategory])], // include sub-category as tag
    severity,
    suggestedFix: fix,
    enrichedBy: llm.name,
    enrichDurationMs: Date.now() - start,
  };
}

/**
 * Apply enrichment results to a Memory entity (mutates in place).
 * Merges new tags with existing ones and adds enrichment metadata.
 */
export function applyEnrichment(memory: Memory, enrichment: EnrichmentResult): Memory {
  // Merge tags (keep existing, add new)
  const existingTags = new Set(memory.tags);
  for (const tag of enrichment.tags) {
    existingTags.add(tag);
  }
  memory.tags = [...existingTags];

  // Add severity and sub-category metadata
  if (!memory.resolution && enrichment.suggestedFix) {
    memory.resolution = enrichment.suggestedFix;
  }

  return memory;
}

/**
 * Enrich multiple memories in batch.
 * Processes sequentially to avoid overwhelming a small local model.
 */
export async function enrichMemories(
  llm: LlmProvider,
  memories: Memory[],
  options: { suggestFixes?: boolean; onProgress?: (i: number, total: number) => void } = {},
): Promise<{ memory: Memory; enrichment: EnrichmentResult }[]> {
  const results: { memory: Memory; enrichment: EnrichmentResult }[] = [];

  for (let i = 0; i < memories.length; i++) {
    options.onProgress?.(i + 1, memories.length);
    const enrichment = await enrichMemory(llm, memories[i], options);
    applyEnrichment(memories[i], enrichment);
    results.push({ memory: memories[i], enrichment });
  }

  return results;
}
