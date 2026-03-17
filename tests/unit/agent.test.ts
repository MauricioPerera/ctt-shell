/**
 * Tests for Agent Layer (recall.ts, learn.ts, autonomous.ts)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/store.js';
import { SearchEngine } from '../../src/search/tfidf.js';
import { CircuitBreaker } from '../../src/guardrails/circuit-breaker.js';
import { recall, contextToPrompt } from '../../src/agent/recall.js';
import { learnSkill, learnFromError, learnFix } from '../../src/agent/learn.js';
import type { Knowledge, Skill, Memory, ExecutionPlan, ExecutionResult } from '../../src/types/entities.js';

let store: Store;
let search: SearchEngine;
let tempDir: string;

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'ctt-agent-test-'));
  store = new Store({ root: tempDir });
  search = new SearchEngine();
}

function teardown() {
  rmSync(tempDir, { recursive: true, force: true });
}

function makeKnowledge(overrides: Partial<Knowledge> = {}): Knowledge {
  return {
    id: '',
    type: 'knowledge',
    domainId: 'echo',
    createdAt: '',
    updatedAt: '',
    tags: ['echo', 'items'],
    operationId: 'echo.items.create',
    displayName: 'Create Item',
    description: 'Creates a new item in the echo system',
    category: 'items',
    parameters: [
      { name: 'name', type: 'string', required: true, description: 'Item name' },
    ],
    ...overrides,
  };
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: '',
    type: 'skill',
    domainId: 'echo',
    createdAt: '',
    updatedAt: '',
    tags: ['auto-learned', 'echo'],
    name: 'Create an item',
    description: 'Learned skill for creating items',
    goal: 'Create an item',
    useCases: ['Create an item'],
    steps: [{ stepId: 1, operationId: 'echo.items.create', description: 'Create', params: { name: 'Test' } }],
    status: 'experimental',
    successCount: 1,
    failureCount: 0,
    ...overrides,
  };
}

function makePlan(): ExecutionPlan {
  return {
    goal: 'Create an item',
    domainId: 'echo',
    steps: [
      { stepId: 1, operationId: 'echo.items.create', description: 'Create item', params: { name: 'Test' } },
    ],
  };
}

function makeSuccessResult(): ExecutionResult {
  return {
    success: true,
    goal: 'Create an item',
    domainId: 'echo',
    steps: [
      { stepId: 1, operationId: 'echo.items.create', success: true, response: { id: 1 }, durationMs: 10 },
    ],
    totalDurationMs: 10,
  };
}

function makeFailResult(): ExecutionResult {
  return {
    success: false,
    goal: 'Create an item',
    domainId: 'echo',
    steps: [
      { stepId: 1, operationId: 'echo.items.create', success: false, error: 'Not found', durationMs: 10 },
    ],
    totalDurationMs: 10,
    error: 'Step 1 failed: Not found',
  };
}

// ─── Recall Tests ─────────────────────────────────────────────────────────────

describe('Recall', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('returns knowledge, skills, and memories from search', async () => {
    const k = store.save(makeKnowledge());
    const s = store.save(makeSkill());
    search.index([k, s]);

    const ctx = await recall('create item', search, new CircuitBreaker(store));
    assert.ok(ctx.knowledge.length > 0);
    // Skills may or may not match depending on search relevance
    assert.ok(Array.isArray(ctx.skills));
    assert.ok(Array.isArray(ctx.memories));
    assert.ok(Array.isArray(ctx.antiPatterns));
  });

  it('respects maxKnowledge limit', async () => {
    const entities: Knowledge[] = [];
    for (let i = 0; i < 15; i++) {
      entities.push(store.save(makeKnowledge({
        operationId: `echo.item${i}.create`,
        displayName: `Create Item ${i}`,
      })));
    }
    search.index(entities);

    const ctx = await recall('create item', search, new CircuitBreaker(store), { maxKnowledge: 5 });
    assert.ok(ctx.knowledge.length <= 5);
  });

  it('filters deprecated skills', async () => {
    const k = store.save(makeKnowledge());
    const deprecated = store.save(makeSkill({ status: 'deprecated', name: 'Old skill' }));
    search.index([k, deprecated]);

    const ctx = await recall('create item', search, new CircuitBreaker(store));
    const depSkills = ctx.skills.filter(s => s.status === 'deprecated');
    assert.equal(depSkills.length, 0);
  });

  it('includes anti-patterns from circuit breaker', async () => {
    const k = store.save(makeKnowledge());
    search.index([k]);

    const cb = new CircuitBreaker(store);
    cb.recordError('echo.items.create', 'Timeout error', 'Increase timeout');

    const ctx = await recall('create item', search, cb);
    assert.ok(ctx.antiPatterns.length > 0);
    assert.equal(ctx.antiPatterns[0].target, 'echo.items.create');
  });
});

// ─── contextToPrompt Tests ────────────────────────────────────────────────────

describe('contextToPrompt', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('generates prompt with available operations', () => {
    const ctx = {
      knowledge: [makeKnowledge()],
      skills: [],
      memories: [],
      antiPatterns: [],
      queryExpansions: [],
    };

    const prompt = contextToPrompt(ctx);
    assert.ok(prompt.includes('## Available Operations'));
    assert.ok(prompt.includes('echo.items.create'));
    assert.ok(prompt.includes('Create Item'));
  });

  it('compact mode uses one-line format', () => {
    const ctx = {
      knowledge: [makeKnowledge()],
      skills: [],
      memories: [],
      antiPatterns: [],
      queryExpansions: [],
    };

    const prompt = contextToPrompt(ctx, true);
    assert.ok(prompt.includes('- echo.items.create:'));
    assert.ok(!prompt.includes('Parameters:'));
  });

  it('separates context knowledge from domain operations', () => {
    const contextK = makeKnowledge({
      domainId: 'context',
      operationId: 'context.pricing',
      displayName: 'Pricing Info',
      description: 'Basic plan $29/month',
    });
    const domainK = makeKnowledge();

    const ctx = {
      knowledge: [contextK, domainK],
      skills: [],
      memories: [],
      antiPatterns: [],
      queryExpansions: [],
    };

    const prompt = contextToPrompt(ctx);
    assert.ok(prompt.includes('## Background Context'));
    assert.ok(prompt.includes('Pricing Info'));
    assert.ok(prompt.includes('## Available Operations'));
  });

  it('includes proven patterns section for skills', () => {
    const ctx = {
      knowledge: [],
      skills: [makeSkill({ status: 'proven' })],
      memories: [],
      antiPatterns: [],
      queryExpansions: [],
    };

    const prompt = contextToPrompt(ctx);
    assert.ok(prompt.includes('## Proven Patterns'));
  });

  it('includes anti-patterns section', () => {
    const ctx = {
      knowledge: [],
      skills: [],
      memories: [],
      antiPatterns: [{ target: 'op.x', error: 'Timeout', resolution: 'Retry later' }],
      queryExpansions: [],
    };

    const prompt = contextToPrompt(ctx);
    assert.ok(prompt.includes('## Known Issues'));
    assert.ok(prompt.includes('Fix: Retry later'));
  });

  it('includes past learnings for fix/optimization memories', () => {
    const fixMem: Memory = {
      id: 'mem1',
      type: 'memory',
      domainId: 'echo',
      createdAt: '',
      updatedAt: '',
      tags: [],
      category: 'fix',
      content: 'Use POST not GET',
      resolution: 'Changed method',
      relevance: 1.0,
    };

    const ctx = {
      knowledge: [],
      skills: [],
      memories: [fixMem],
      antiPatterns: [],
      queryExpansions: [],
    };

    const prompt = contextToPrompt(ctx);
    assert.ok(prompt.includes('## Past Learnings'));
    assert.ok(prompt.includes('FIX:'));
  });

  it('compact mode skips past learnings', () => {
    const fixMem: Memory = {
      id: 'mem1',
      type: 'memory',
      domainId: 'echo',
      createdAt: '',
      updatedAt: '',
      tags: [],
      category: 'fix',
      content: 'Use POST not GET',
      resolution: 'Changed method',
      relevance: 1.0,
    };

    const ctx = {
      knowledge: [],
      skills: [],
      memories: [fixMem],
      antiPatterns: [],
      queryExpansions: [],
    };

    const prompt = contextToPrompt(ctx, true);
    assert.ok(!prompt.includes('## Past Learnings'));
  });
});

// ─── Learn Tests ──────────────────────────────────────────────────────────────

describe('learnSkill', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('creates experimental skill on first success', () => {
    const skill = learnSkill(store, makePlan(), makeSuccessResult(), 'echo');
    assert.equal(skill.status, 'experimental');
    assert.equal(skill.successCount, 1);
    assert.equal(skill.failureCount, 0);
    assert.equal(skill.goal, 'Create an item');
    assert.equal(skill.domainId, 'echo');
  });

  it('increments success count on repeat', () => {
    learnSkill(store, makePlan(), makeSuccessResult(), 'echo');
    const skill2 = learnSkill(store, makePlan(), makeSuccessResult(), 'echo');
    assert.equal(skill2.successCount, 2);
    assert.equal(skill2.status, 'experimental');
  });

  it('promotes to proven at 5 successes', () => {
    for (let i = 0; i < 4; i++) {
      learnSkill(store, makePlan(), makeSuccessResult(), 'echo');
    }
    const skill = learnSkill(store, makePlan(), makeSuccessResult(), 'echo');
    assert.equal(skill.successCount, 5);
    assert.equal(skill.status, 'proven');
  });

  it('sanitizes credentials in saved skill steps', () => {
    const plan: ExecutionPlan = {
      goal: 'Create with secret',
      steps: [
        { stepId: 1, operationId: 'echo.items.create', description: 'Create', params: { name: 'Test', token: 'sk-ant-1234567890abcdefghij' } },
      ],
    };

    const skill = learnSkill(store, plan, makeSuccessResult(), 'echo');
    const savedParams = skill.steps[0].params as Record<string, string>;
    // sk-ant prefix should be redacted
    assert.ok(!savedParams.token?.includes('sk-ant-'));
  });
});

describe('learnFromError', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('saves error memory', () => {
    const cb = new CircuitBreaker(store);
    const memory = learnFromError(store, cb, makePlan(), makeFailResult(), 'echo');
    assert.equal(memory.category, 'error');
    assert.equal(memory.content, 'Step 1 failed: Not found');
    assert.equal(memory.operationId, 'echo.items.create');
  });

  it('updates circuit breaker for failed steps', () => {
    const cb = new CircuitBreaker(store);
    learnFromError(store, cb, makePlan(), makeFailResult(), 'echo');

    const result = cb.check('echo.items.create');
    assert.equal(result.errorCount, 1);
  });

  it('degrades existing skill on failure', () => {
    // First create a skill
    learnSkill(store, makePlan(), makeSuccessResult(), 'echo');

    // Then fail
    const cb = new CircuitBreaker(store);
    learnFromError(store, cb, makePlan(), makeFailResult(), 'echo');

    const skills = store.findBy<Skill>('skill', s => s.goal.toLowerCase() === 'create an item');
    assert.equal(skills[0].failureCount, 1);
  });

  it('deprecates skill after 5 failures', () => {
    learnSkill(store, makePlan(), makeSuccessResult(), 'echo');

    const cb = new CircuitBreaker(store);
    for (let i = 0; i < 5; i++) {
      learnFromError(store, cb, makePlan(), makeFailResult(), 'echo');
    }

    const skills = store.findBy<Skill>('skill', s => s.goal.toLowerCase() === 'create an item');
    assert.equal(skills[0].status, 'deprecated');
  });
});

describe('learnFix', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('saves fix memory with resolution', () => {
    const cb = new CircuitBreaker(store);
    cb.recordError('echo.items.create', 'Timeout');

    const memory = learnFix(store, cb, 'echo.items.create', 'Timeout', 'Increased timeout to 30s', 'echo');
    assert.equal(memory.category, 'fix');
    assert.equal(memory.resolution, 'Increased timeout to 30s');
  });

  it('resets circuit breaker on fix', () => {
    const cb = new CircuitBreaker(store);
    cb.recordError('echo.items.create', 'err1');
    cb.recordError('echo.items.create', 'err2');
    assert.equal(cb.check('echo.items.create').errorCount, 2);

    learnFix(store, cb, 'echo.items.create', 'err', 'fix', 'echo');
    assert.equal(cb.check('echo.items.create').errorCount, 0);
  });
});
