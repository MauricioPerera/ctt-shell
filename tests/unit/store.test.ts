/**
 * Tests for Content-Addressable Store (storage/store.ts)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/store.js';
import type { Knowledge, Memory } from '../../src/types/entities.js';

let store: Store;
let tempDir: string;

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'ctt-shell-test-'));
  store = new Store({ root: tempDir });
}

function teardown() {
  rmSync(tempDir, { recursive: true, force: true });
}

describe('Store', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('saves and retrieves a Knowledge entity', () => {
    const entity: Knowledge = {
      id: '', type: 'knowledge', domainId: 'test',
      createdAt: '', updatedAt: '', tags: ['test'],
      operationId: 'test.op', displayName: 'Test Op',
      description: 'A test operation', category: 'test',
      parameters: [],
    };
    const saved = store.save(entity);
    assert.ok(saved.id.length > 0);
    assert.ok(saved.createdAt.length > 0);
    assert.ok(saved.updatedAt.length > 0);

    const retrieved = store.get<Knowledge>('knowledge', saved.id);
    assert.notEqual(retrieved, null);
    assert.equal(retrieved!.operationId, 'test.op');
    assert.equal(retrieved!.displayName, 'Test Op');
  });

  it('deduplicates identical entities (content-addressable)', () => {
    const entity: Knowledge = {
      id: 'fixed-id', type: 'knowledge', domainId: 'test',
      createdAt: '2024-01-01', updatedAt: '2024-01-01', tags: ['test'],
      operationId: 'test.dedup', displayName: 'Dedup Test',
      description: 'Test dedup', category: 'test',
      parameters: [],
    };

    store.save(entity);
    store.save(entity); // Same content, should be deduplicated
    const list = store.list<Knowledge>('knowledge');
    // Should only have 1 entity (dedup by SHA-256)
    assert.equal(list.filter(e => e.operationId === 'test.dedup').length, 1);
  });

  it('lists entities by type', () => {
    const k1: Knowledge = {
      id: '', type: 'knowledge', domainId: 'test',
      createdAt: '', updatedAt: '', tags: ['a'],
      operationId: 'op1', displayName: 'Op 1',
      description: '', category: 'test', parameters: [],
    };
    const k2: Knowledge = {
      id: '', type: 'knowledge', domainId: 'test',
      createdAt: '', updatedAt: '', tags: ['b'],
      operationId: 'op2', displayName: 'Op 2',
      description: '', category: 'test', parameters: [],
    };
    store.save(k1);
    store.save(k2);

    const list = store.list<Knowledge>('knowledge');
    assert.ok(list.length >= 2);
  });

  it('deletes an entity', () => {
    const entity: Knowledge = {
      id: '', type: 'knowledge', domainId: 'test',
      createdAt: '', updatedAt: '', tags: [],
      operationId: 'del.me', displayName: 'Delete Me',
      description: '', category: 'test', parameters: [],
    };
    const saved = store.save(entity);
    assert.equal(store.delete('knowledge', saved.id), true);
    assert.equal(store.get('knowledge', saved.id), null);
  });

  it('returns null for non-existent entity', () => {
    const result = store.get('knowledge', 'non-existent-id');
    assert.equal(result, null);
  });

  it('counts entities correctly', () => {
    const before = store.count('memory');
    const mem: Memory = {
      id: '', type: 'memory', domainId: 'test',
      createdAt: '', updatedAt: '', tags: [],
      category: 'error', content: 'test error', relevance: 1,
    };
    store.save(mem);
    assert.equal(store.count('memory'), before + 1);
  });

  it('stats returns all type counts', () => {
    const stats = store.stats();
    assert.ok('knowledge' in stats);
    assert.ok('skill' in stats);
    assert.ok('memory' in stats);
    assert.ok('profile' in stats);
  });

  it('saveBatch saves multiple entities', () => {
    const entities: Knowledge[] = [
      { id: '', type: 'knowledge', domainId: 'test', createdAt: '', updatedAt: '', tags: [], operationId: 'batch1', displayName: 'B1', description: '', category: 'test', parameters: [] },
      { id: '', type: 'knowledge', domainId: 'test', createdAt: '', updatedAt: '', tags: [], operationId: 'batch2', displayName: 'B2', description: '', category: 'test', parameters: [] },
    ];
    const saved = store.saveBatch(entities);
    assert.equal(saved.length, 2);
    assert.ok(saved[0].id.length > 0);
    assert.ok(saved[1].id.length > 0);
  });
});
