/**
 * Tests for Circuit Breaker (guardrails/circuit-breaker.ts)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/store.js';
import { CircuitBreaker } from '../../src/guardrails/circuit-breaker.js';
import type { Memory } from '../../src/types/entities.js';

let store: Store;
let tempDir: string;

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'ctt-cb-test-'));
  store = new Store({ root: tempDir });
}

function teardown() {
  rmSync(tempDir, { recursive: true, force: true });
}

describe('CircuitBreaker', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('returns closed for unknown targets', () => {
    const cb = new CircuitBreaker(store);
    const result = cb.check('unknown.op');
    assert.equal(result.open, false);
    assert.equal(result.errorCount, 0);
    assert.equal(result.target, 'unknown.op');
  });

  it('opens circuit after reaching threshold', () => {
    const cb = new CircuitBreaker(store, 3);
    cb.recordError('test.op', 'Error 1');
    cb.recordError('test.op', 'Error 2');
    assert.equal(cb.check('test.op').open, false);

    cb.recordError('test.op', 'Error 3');
    const result = cb.check('test.op');
    assert.equal(result.open, true);
    assert.equal(result.errorCount, 3);
  });

  it('recordSuccess resets error count', () => {
    const cb = new CircuitBreaker(store, 3);
    cb.recordError('test.op', 'Error 1');
    cb.recordError('test.op', 'Error 2');
    assert.equal(cb.check('test.op').errorCount, 2);

    cb.recordSuccess('test.op');
    assert.equal(cb.check('test.op').errorCount, 0);
    assert.equal(cb.check('test.op').open, false);
  });

  it('tracks error reasons (last 3)', () => {
    const cb = new CircuitBreaker(store, 5);
    cb.recordError('api.call', 'Timeout');
    cb.recordError('api.call', '404 Not Found');
    cb.recordError('api.call', '500 Internal');
    cb.recordError('api.call', 'Connection refused');

    const result = cb.check('api.call');
    // last 3 reasons
    assert.equal(result.reasons.length, 3);
    assert.ok(result.reasons.includes('404 Not Found'));
    assert.ok(result.reasons.includes('500 Internal'));
    assert.ok(result.reasons.includes('Connection refused'));
  });

  it('tracks resolutions without duplicates', () => {
    const cb = new CircuitBreaker(store);
    cb.recordError('api.call', 'Auth error', 'Use Bearer token');
    cb.recordError('api.call', 'Auth error again', 'Use Bearer token');
    cb.recordError('api.call', 'Different error', 'Check URL format');

    const result = cb.check('api.call');
    assert.equal(result.resolutions.length, 2);
    assert.ok(result.resolutions.includes('Use Bearer token'));
    assert.ok(result.resolutions.includes('Check URL format'));
  });

  it('checkPlan returns only open circuits', () => {
    const cb = new CircuitBreaker(store, 2);
    cb.recordError('op.a', 'err1');
    cb.recordError('op.a', 'err2'); // opens
    cb.recordError('op.b', 'err1'); // still closed

    const blocked = cb.checkPlan(['op.a', 'op.b', 'op.c']);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].target, 'op.a');
  });

  it('getAntiPatterns returns deduplicated entries', () => {
    const cb = new CircuitBreaker(store);
    cb.recordError('op.a', 'Timeout', 'Increase timeout');
    cb.recordError('op.a', 'Timeout'); // duplicate reason
    cb.recordError('op.b', 'Bad request');

    const patterns = cb.getAntiPatterns();
    assert.ok(patterns.length >= 2);
    const opAPatterns = patterns.filter(p => p.target === 'op.a');
    // Should not have duplicate "Timeout" entries
    const timeoutPatterns = opAPatterns.filter(p => p.error === 'Timeout');
    assert.equal(timeoutPatterns.length, 1);
    assert.equal(timeoutPatterns[0].resolution, 'Increase timeout');
  });

  it('loads error counts from stored Memory entities', () => {
    // Seed store with error memories
    const mem: Memory = {
      id: '',
      type: 'memory',
      domainId: 'test',
      createdAt: '',
      updatedAt: '',
      tags: ['ctt-error'],
      category: 'error',
      operationId: 'stored.op',
      content: 'Previous error',
      resolution: 'Fix it',
      relevance: 1.0,
    };
    store.save(mem);
    store.save({ ...mem, id: '', content: 'Another error' });
    store.save({ ...mem, id: '', content: 'Third error' });

    // Fresh circuit breaker should load from store
    const cb = new CircuitBreaker(store, 3);
    const result = cb.check('stored.op');
    assert.equal(result.open, true);
    assert.equal(result.errorCount, 3);
  });

  it('loads fix memories as resolutions', () => {
    const fixMem: Memory = {
      id: '',
      type: 'memory',
      domainId: 'test',
      createdAt: '',
      updatedAt: '',
      tags: ['ctt-fix'],
      category: 'fix',
      operationId: 'fix.op',
      content: 'Fixed issue',
      resolution: 'Use correct endpoint',
      relevance: 1.0,
    };
    store.save(fixMem);

    const cb = new CircuitBreaker(store);
    const result = cb.check('fix.op');
    assert.equal(result.open, false);
    assert.ok(result.resolutions.includes('Use correct endpoint'));
  });

  it('extractHost parses URLs correctly', () => {
    assert.equal(CircuitBreaker.extractHost('https://api.example.com/v1/data'), 'api.example.com');
    assert.equal(CircuitBreaker.extractHost('http://localhost:3000/test'), 'localhost');
    assert.equal(CircuitBreaker.extractHost('not-a-url'), null);
  });

  it('includes reasons in open circuit message', () => {
    const cb = new CircuitBreaker(store, 2);
    cb.recordError('op.x', 'Connection timeout');
    cb.recordError('op.x', 'DNS resolution failed');

    const result = cb.check('op.x');
    assert.ok(result.message.includes('Circuit OPEN'));
    assert.ok(result.message.includes('Reasons'));
  });

  it('separate targets are independent', () => {
    const cb = new CircuitBreaker(store, 2);
    cb.recordError('op.a', 'err');
    cb.recordError('op.a', 'err');
    cb.recordError('op.b', 'err');

    assert.equal(cb.check('op.a').open, true);
    assert.equal(cb.check('op.b').open, false);
  });
});
