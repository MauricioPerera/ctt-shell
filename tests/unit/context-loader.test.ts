/**
 * Tests for ContextLoader (src/context/loader.ts)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { SearchEngine } from '../../src/search/tfidf.js';
import { ContextLoader } from '../../src/context/loader.js';

const TEST_ROOT = join(process.cwd(), '.ctt-shell-test-ctx-' + process.pid);
const STORE_ROOT = join(TEST_ROOT, 'store');
const CTX_DIR = join(TEST_ROOT, 'context');

describe('ContextLoader', () => {
  let store: Store;
  let search: SearchEngine;
  let loader: ContextLoader;

  beforeEach(() => {
    mkdirSync(STORE_ROOT, { recursive: true });
    mkdirSync(CTX_DIR, { recursive: true });
    store = new Store({ root: STORE_ROOT });
    search = new SearchEngine();
    loader = new ContextLoader(store, search);
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  // ─── addText ──────────────────────────────────────────────────────────────

  it('addText creates a Knowledge entity with domainId=context', () => {
    const k = loader.addText('Our premium plan costs $99/month');
    assert.equal(k.type, 'knowledge');
    assert.equal(k.domainId, 'context');
    assert.ok(k.id.startsWith('ctx-'));
    assert.ok(k.description.includes('$99/month'));
    assert.equal(k.operationId, 'context.general');
  });

  it('addText uses provided category and tags', () => {
    const k = loader.addText('We accept credit cards', ['payment', 'billing'], 'pricing', 'Payment Methods');
    assert.equal(k.displayName, 'Payment Methods');
    assert.equal(k.category, 'pricing');
    assert.equal(k.operationId, 'context.pricing');
    assert.ok(k.tags.includes('pricing'));
    assert.ok(k.tags.includes('payment'));
    assert.ok(k.tags.includes('billing'));
  });

  it('addText auto-generates title from first 80 chars', () => {
    const longText = 'A'.repeat(100);
    const k = loader.addText(longText);
    assert.equal(k.displayName.length, 80);
  });

  // ─── list / remove / clear ────────────────────────────────────────────────

  it('list returns all context entries', () => {
    loader.addText('Entry one');
    loader.addText('Entry two');
    loader.addText('Entry three');
    const entries = loader.list();
    assert.equal(entries.length, 3);
    assert.ok(entries.every(e => e.domainId === 'context'));
  });

  it('remove deletes a context entry', () => {
    const k = loader.addText('Temporary');
    assert.equal(loader.list().length, 1);
    const removed = loader.remove(k.id);
    assert.ok(removed);
    assert.equal(loader.list().length, 0);
  });

  it('remove returns false for non-existent id', () => {
    assert.equal(loader.remove('nonexistent'), false);
  });

  it('clear removes all context entries', () => {
    loader.addText('One');
    loader.addText('Two');
    loader.addText('Three');
    const count = loader.clear();
    assert.equal(count, 3);
    assert.equal(loader.list().length, 0);
  });

  it('count returns number of entries', () => {
    assert.equal(loader.count(), 0);
    loader.addText('One');
    loader.addText('Two');
    assert.equal(loader.count(), 2);
  });

  // ─── loadFile: text ─────────────────────────────────────────────────────

  it('loadFile loads a .txt file as single entry', () => {
    const filePath = join(CTX_DIR, 'info.txt');
    writeFileSync(filePath, 'Our company was founded in 2020.');
    const entries = loader.loadFile(filePath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].displayName, 'info');
    assert.ok(entries[0].description.includes('2020'));
  });

  it('loadFile throws for non-existent file', () => {
    assert.throws(() => loader.loadFile('/nonexistent/file.txt'), /File not found/);
  });

  // ─── loadFile: markdown ───────────────────────────────────────────────────

  it('loadFile splits markdown by ## headers', () => {
    const filePath = join(CTX_DIR, 'products.md');
    writeFileSync(filePath, `# Products

Overview of our product line.

## Basic Plan

The basic plan costs $29/month and includes 5 users.

## Premium Plan

The premium plan costs $99/month and includes unlimited users.

## Enterprise Plan

Custom pricing for large organizations.
`);
    const entries = loader.loadFile(filePath);
    // Should have: preamble (if >20 chars) + 3 sections
    assert.ok(entries.length >= 3, `Expected at least 3 entries, got ${entries.length}`);

    const titles = entries.map(e => e.displayName);
    assert.ok(titles.some(t => t.includes('Basic Plan')));
    assert.ok(titles.some(t => t.includes('Premium Plan')));
    assert.ok(titles.some(t => t.includes('Enterprise Plan')));
  });

  it('loadFile handles markdown with no ## headers as single entry', () => {
    const filePath = join(CTX_DIR, 'simple.md');
    writeFileSync(filePath, `# Company Info

We are a SaaS company based in Miami.
We sell project management tools.
`);
    const entries = loader.loadFile(filePath);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].displayName.includes('Company Info'));
  });

  // ─── loadFile: JSON ───────────────────────────────────────────────────────

  it('loadFile loads JSON array of context entries', () => {
    const filePath = join(CTX_DIR, 'knowledge.json');
    writeFileSync(filePath, JSON.stringify([
      { title: 'Pricing', content: 'Basic plan is $29/month', category: 'pricing' },
      { title: 'Support', content: 'We offer 24/7 support', category: 'support' },
    ]));
    const entries = loader.loadFile(filePath);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].displayName, 'Pricing');
    assert.equal(entries[1].displayName, 'Support');
  });

  it('loadFile loads single JSON object', () => {
    const filePath = join(CTX_DIR, 'single.json');
    writeFileSync(filePath, JSON.stringify({ title: 'FAQ', content: 'Frequently asked questions' }));
    const entries = loader.loadFile(filePath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].displayName, 'FAQ');
  });

  // ─── loadDirectory ────────────────────────────────────────────────────────

  it('loadDirectory loads all supported files from a directory', () => {
    writeFileSync(join(CTX_DIR, 'a.txt'), 'Text file content');
    writeFileSync(join(CTX_DIR, 'b.md'), '## Section\nMarkdown content');
    writeFileSync(join(CTX_DIR, 'c.json'), JSON.stringify({ title: 'JSON', content: 'From JSON' }));
    writeFileSync(join(CTX_DIR, 'skip.png'), 'not a text file');

    const entries = loader.loadDirectory(CTX_DIR);
    // a.txt (1) + b.md (1 section) + c.json (1) = 3
    assert.ok(entries.length >= 3, `Expected at least 3 entries, got ${entries.length}`);
  });

  it('loadDirectory returns empty array for non-existent directory', () => {
    const entries = loader.loadDirectory('/nonexistent/dir');
    assert.equal(entries.length, 0);
  });

  // ─── rebuildIndex ─────────────────────────────────────────────────────────

  it('rebuildIndex makes context entries searchable via TF-IDF', () => {
    loader.addText('Our premium plan costs $99/month with unlimited users', ['pricing']);
    loader.addText('We use React and TypeScript for our frontend', ['tech']);
    loader.rebuildIndex();

    const results = search.search('premium pricing plan', 5);
    assert.ok(results.length > 0, 'Should find at least one result');
    // The pricing entry should rank higher
    const topResult = results[0].entity as unknown as Record<string, unknown>;
    assert.ok(
      (topResult.description as string).includes('premium') || (topResult.description as string).includes('pricing'),
      'Top result should match pricing query',
    );
  });

  // ─── Integration: domainId filtering ──────────────────────────────────────

  it('context entries have domainId=context, not mixed with domain knowledge', () => {
    loader.addText('Business context entry');
    const entries = loader.list();
    assert.ok(entries.every(e => e.domainId === 'context'));
    assert.ok(entries.every(e => e.operationId.startsWith('context.')));
  });
});
