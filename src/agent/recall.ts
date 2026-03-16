/**
 * CTT Recall — builds enriched context for LLM prompts.
 * Searches Knowledge, Skills, and Memories via TF-IDF.
 */

import type { Knowledge, Skill, Memory } from '../types/entities.js';
import type { SearchEngine } from '../search/tfidf.js';
import type { CircuitBreaker } from '../guardrails/circuit-breaker.js';

export interface CTTContext {
  knowledge: Knowledge[];
  skills: Skill[];
  memories: Memory[];
  antiPatterns: { target: string; error: string; resolution?: string }[];
  queryExpansions: string[];
}

export interface RecallOptions {
  maxKnowledge?: number;   // default 10
  maxSkills?: number;      // default 3
  maxMemories?: number;    // default 5
  compact?: boolean;       // reduced output for small models
}

export function recall(
  goal: string,
  search: SearchEngine,
  circuitBreaker: CircuitBreaker,
  options: RecallOptions = {},
): CTTContext {
  const { maxKnowledge = 10, maxSkills = 3, maxMemories = 5 } = options;

  const results = search.search(goal, maxKnowledge + maxSkills + maxMemories + 10);

  const knowledge: Knowledge[] = [];
  const skills: Skill[] = [];
  const memories: Memory[] = [];

  for (const r of results) {
    if (r.entity.type === 'knowledge' && knowledge.length < maxKnowledge) {
      knowledge.push(r.entity as Knowledge);
    } else if (r.entity.type === 'skill' && skills.length < maxSkills) {
      // Prefer proven skills
      const skill = r.entity as Skill;
      if (skill.status !== 'deprecated') skills.push(skill);
    } else if (r.entity.type === 'memory' && memories.length < maxMemories) {
      memories.push(r.entity as Memory);
    }
  }

  const antiPatterns = circuitBreaker.getAntiPatterns(10);
  const queryExpansions = results.flatMap(r => r.matchedTerms);

  return { knowledge, skills, memories, antiPatterns, queryExpansions: [...new Set(queryExpansions)] };
}

/** Serialize CTTContext to a string for injection into LLM prompt */
export function contextToPrompt(ctx: CTTContext, compact = false): string {
  const sections: string[] = [];

  // Separate user context from domain operations
  const contextKnowledge = ctx.knowledge.filter(k => k.domainId === 'context');
  const domainKnowledge = ctx.knowledge.filter(k => k.domainId !== 'context');

  // User-provided business context first (gives LLM background info)
  if (contextKnowledge.length > 0) {
    sections.push('## Background Context');
    for (const k of contextKnowledge) {
      if (compact) {
        sections.push(`- ${k.displayName}: ${k.description.slice(0, 200)}`);
      } else {
        sections.push(`### ${k.displayName}`);
        sections.push(k.description);
      }
    }
    sections.push('');
  }

  if (domainKnowledge.length > 0) {
    sections.push('## Available Operations');
    for (const k of domainKnowledge) {
      if (compact) {
        // One-line format for small models
        const params = k.parameters
          .filter(p => p.required)
          .map(p => `${p.name}:${p.type}`)
          .join(', ');
        sections.push(`- ${k.operationId}: ${k.displayName} [${params}]`);
      } else {
        sections.push(`### ${k.displayName} (${k.operationId})`);
        sections.push(`${k.description}`);
        sections.push(`Category: ${k.category}`);
        if (k.parameters.length > 0) {
          sections.push('Parameters:');
          for (const p of k.parameters) {
            const req = p.required ? '(required)' : '(optional)';
            sections.push(`  - ${p.name}: ${p.type} ${req} — ${p.description}`);
          }
        }
      }
    }
  }

  if (ctx.skills.length > 0) {
    sections.push('\n## Proven Patterns (few-shot examples)');
    for (const s of ctx.skills) {
      sections.push(`### ${s.name}`);
      sections.push(`Goal: ${s.goal}`);
      sections.push(`Steps: ${JSON.stringify(s.steps, null, compact ? 0 : 2)}`);
    }
  }

  if (ctx.antiPatterns.length > 0) {
    sections.push('\n## Known Issues (avoid these mistakes)');
    for (const ap of ctx.antiPatterns) {
      sections.push(`- ${ap.target}: ${ap.error}${ap.resolution ? ` → Fix: ${ap.resolution}` : ''}`);
    }
  }

  if (ctx.memories.length > 0 && !compact) {
    sections.push('\n## Past Learnings');
    for (const m of ctx.memories) {
      if (m.category === 'fix') {
        sections.push(`- FIX: ${m.content}${m.resolution ? ` → ${m.resolution}` : ''}`);
      } else if (m.category === 'optimization') {
        sections.push(`- TIP: ${m.content}`);
      }
    }
  }

  return sections.join('\n');
}
