/**
 * Tests for TF-IDF Search Engine (search/tfidf.ts)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SearchEngine } from '../../src/search/tfidf.js';
import type { Knowledge } from '../../src/types/entities.js';

function makeKnowledge(id: string, opId: string, displayName: string, description: string, tags: string[] = []): Knowledge {
  return {
    id, type: 'knowledge', domainId: 'test',
    createdAt: '', updatedAt: '', tags,
    operationId: opId, displayName, description,
    category: 'test', parameters: [],
  };
}

describe('SearchEngine', () => {
  let engine: SearchEngine;

  beforeEach(() => {
    engine = new SearchEngine();
    engine.index([
      makeKnowledge('1', 'echo.items.create', 'Create Item', 'Creates a new item', ['create', 'item']),
      makeKnowledge('2', 'echo.items.list', 'List Items', 'Lists all items', ['list', 'item']),
      makeKnowledge('3', 'echo.items.delete', 'Delete Item', 'Deletes an item by ID', ['delete', 'item']),
      makeKnowledge('4', 'browser.navigate', 'Navigate to URL', 'Opens a URL in the browser', ['browser', 'navigate']),
      makeKnowledge('5', 'browser.screenshot', 'Take Screenshot', 'Takes a screenshot of the page', ['browser', 'screenshot']),
    ]);
  });

  it('finds entities matching a query', () => {
    const results = engine.search('create item');
    assert.ok(results.length > 0);
    assert.equal((results[0].entity as Knowledge).operationId, 'echo.items.create');
  });

  it('ranks more relevant results higher', () => {
    const results = engine.search('delete item');
    assert.ok(results.length > 0);
    assert.equal((results[0].entity as Knowledge).operationId, 'echo.items.delete');
  });

  it('returns empty for unmatched queries', () => {
    const results = engine.search('xyznonexistent');
    assert.equal(results.length, 0);
  });

  it('respects limit parameter', () => {
    const results = engine.search('item', 2);
    assert.ok(results.length <= 2);
  });

  it('finds browser operations', () => {
    const results = engine.search('navigate browser URL');
    assert.ok(results.length > 0);
    assert.equal((results[0].entity as Knowledge).operationId, 'browser.navigate');
  });

  it('uses query expansion when configured', () => {
    engine.addExpansions({
      'photo': ['screenshot', 'capture', 'image'],
    });
    // Re-index after adding expansions
    engine.index([
      makeKnowledge('5', 'browser.screenshot', 'Take Screenshot', 'Takes a screenshot of the page', ['browser', 'screenshot']),
    ]);
    const results = engine.search('photo');
    assert.ok(results.length > 0);
    // Should find screenshot via expansion photo → screenshot
    assert.equal((results[0].entity as Knowledge).operationId, 'browser.screenshot');
  });
});
