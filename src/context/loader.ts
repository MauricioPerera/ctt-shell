/**
 * Context Loader — ingest user-provided knowledge into CTT memory.
 *
 * Reads files (.md, .txt, .json) or inline text and creates Knowledge
 * entities with domainId='context'. These get indexed by TF-IDF and
 * appear in RECALL results, giving the LLM business context alongside
 * domain operation schemas.
 *
 * Supports:
 * - Single file: loadFile('docs/products.md')
 * - Directory scan: loadDirectory('.ctt-shell/context/')
 * - Inline text: addText('Premium plan costs $99/month', ['pricing'])
 * - JSON import: loadJsonFile('knowledge.json') for structured bulk import
 *
 * Markdown files are split by ## headers into separate Knowledge entities
 * so each section is independently searchable.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Knowledge } from '../types/entities.js';
import type { Store } from '../storage/store.js';
import type { SearchEngine } from '../search/tfidf.js';

export interface ContextEntry {
  /** Unique id (auto-generated if not provided) */
  id?: string;
  /** Title / display name */
  title: string;
  /** The actual content */
  content: string;
  /** Category for grouping (e.g., 'product', 'policy', 'faq') */
  category?: string;
  /** Tags for TF-IDF boosting */
  tags?: string[];
  /** Source file path (if loaded from file) */
  source?: string;
}

export class ContextLoader {
  private store: Store;
  private search: SearchEngine;

  constructor(store: Store, search: SearchEngine) {
    this.store = store;
    this.search = search;
  }

  // ─── Add Methods ───────────────────────────────────────────────────────────

  /** Add a single text entry as context Knowledge */
  addText(text: string, tags: string[] = [], category = 'general', title?: string): Knowledge {
    const entry: ContextEntry = {
      title: title || text.slice(0, 80).replace(/\n/g, ' ').trim(),
      content: text,
      category,
      tags,
    };
    return this.saveEntry(entry);
  }

  /** Load a file and create Knowledge entities from it */
  loadFile(filePath: string): Knowledge[] {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const raw = readFileSync(filePath, 'utf-8');
    const ext = extname(filePath).toLowerCase();
    const name = basename(filePath, ext);

    switch (ext) {
      case '.md':
      case '.markdown':
        return this.parseMarkdown(raw, name, filePath);
      case '.json':
        return this.parseJson(raw, filePath);
      case '.txt':
      default:
        return [this.saveEntry({
          title: name,
          content: raw,
          category: 'document',
          tags: [name],
          source: filePath,
        })];
    }
  }

  /** Load all files from a directory */
  loadDirectory(dirPath: string): Knowledge[] {
    if (!existsSync(dirPath)) return [];

    const results: Knowledge[] = [];
    const files = readdirSync(dirPath).filter(f => {
      const ext = extname(f).toLowerCase();
      return ['.md', '.markdown', '.txt', '.json'].includes(ext);
    });

    for (const file of files) {
      const fullPath = join(dirPath, file);
      if (statSync(fullPath).isFile()) {
        try {
          results.push(...this.loadFile(fullPath));
        } catch {
          // Skip files that can't be read
        }
      }
    }

    return results;
  }

  // ─── Query Methods ─────────────────────────────────────────────────────────

  /** List all context Knowledge entities */
  list(): Knowledge[] {
    return this.store.findBy<Knowledge>('knowledge', (k) => k.domainId === 'context');
  }

  /** Remove a context entry by id */
  remove(id: string): boolean {
    return this.store.delete('knowledge', id);
  }

  /** Remove all context entries */
  clear(): number {
    const entries = this.list();
    let count = 0;
    for (const entry of entries) {
      if (this.store.delete('knowledge', entry.id)) count++;
    }
    return count;
  }

  /** Count context entries */
  count(): number {
    return this.list().length;
  }

  // ─── Rebuild Index ─────────────────────────────────────────────────────────

  /** Rebuild search index (call after batch operations) */
  rebuildIndex(): void {
    const allEntities = [
      ...this.store.list('knowledge'),
      ...this.store.list('skill'),
      ...this.store.list('memory'),
    ];
    this.search.index(allEntities);
  }

  /** Incrementally add entities to search index */
  addToSearchIndex(entities: Knowledge[]): void {
    this.search.addToIndex(entities);
  }

  // ─── Parsers ───────────────────────────────────────────────────────────────

  /** Parse markdown into sections by ## headers */
  private parseMarkdown(raw: string, docName: string, source: string): Knowledge[] {
    const results: Knowledge[] = [];

    // Split by ## headers
    const sections = raw.split(/^##\s+/m);

    if (sections.length <= 1) {
      // No ## headers — treat as a single document
      // But check for # (h1) title
      const h1Match = raw.match(/^#\s+(.+)$/m);
      const title = h1Match ? h1Match[1].trim() : docName;
      const content = h1Match ? raw.replace(/^#\s+.+$/m, '').trim() : raw.trim();

      if (content.length > 0) {
        results.push(this.saveEntry({
          title,
          content,
          category: 'document',
          tags: this.extractTags(content, docName),
          source,
        }));
      }
      return results;
    }

    // First section (before first ##) might have a # title or preamble
    const preamble = sections[0].trim();
    let docTitle = docName;
    if (preamble) {
      const h1Match = preamble.match(/^#\s+(.+)$/m);
      if (h1Match) {
        docTitle = h1Match[1].trim();
      }
      // Save preamble if it has content beyond just the title
      const preambleContent = preamble.replace(/^#\s+.+$/m, '').trim();
      if (preambleContent.length > 20) {
        results.push(this.saveEntry({
          title: `${docTitle} — Overview`,
          content: preambleContent,
          category: 'document',
          tags: this.extractTags(preambleContent, docName),
          source,
        }));
      }
    }

    // Each ## section becomes its own Knowledge entity
    for (let i = 1; i < sections.length; i++) {
      const section = sections[i];
      const newlineIdx = section.indexOf('\n');
      const sectionTitle = newlineIdx >= 0
        ? section.slice(0, newlineIdx).trim()
        : section.trim();
      const sectionContent = newlineIdx >= 0
        ? section.slice(newlineIdx + 1).trim()
        : '';

      if (sectionContent.length === 0 && sectionTitle.length === 0) continue;

      results.push(this.saveEntry({
        title: `${docTitle} — ${sectionTitle}`,
        content: sectionContent || sectionTitle,
        category: 'document',
        tags: this.extractTags(sectionContent || sectionTitle, docName, sectionTitle),
        source,
      }));
    }

    return results;
  }

  /** Parse JSON: expects array of ContextEntry or single ContextEntry */
  private parseJson(raw: string, source: string): Knowledge[] {
    const data = JSON.parse(raw);
    const entries: ContextEntry[] = Array.isArray(data) ? data : [data];
    return entries.map(entry => this.saveEntry({
      ...entry,
      source: entry.source || source,
    }));
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Convert a ContextEntry to a Knowledge entity and save it */
  private saveEntry(entry: ContextEntry): Knowledge {
    const id = entry.id || `ctx-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const knowledge: Knowledge = {
      id,
      type: 'knowledge',
      domainId: 'context',
      createdAt: now,
      updatedAt: now,
      tags: ['context', entry.category || 'general', ...(entry.tags || [])],
      operationId: `context.${(entry.category || 'general').replace(/\s+/g, '-')}`,
      displayName: entry.title,
      description: entry.content,
      category: entry.category || 'general',
      parameters: [],
      metadata: entry.source ? { source: entry.source } : undefined,
    };

    return this.store.save(knowledge);
  }

  /** Extract meaningful tags from content */
  private extractTags(content: string, ...extraTags: string[]): string[] {
    const tags = new Set<string>(extraTags.filter(Boolean));

    // Extract words that look like proper nouns or important terms
    // (capitalized words that aren't at the start of a sentence)
    const words = content.match(/(?<=[.!?]\s+|\n)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g);
    if (words) {
      for (const w of words.slice(0, 5)) {
        tags.add(w.trim().toLowerCase());
      }
    }

    // Extract quoted terms
    const quoted = content.match(/"([^"]+)"/g);
    if (quoted) {
      for (const q of quoted.slice(0, 3)) {
        tags.add(q.replace(/"/g, '').toLowerCase());
      }
    }

    return [...tags];
  }
}
