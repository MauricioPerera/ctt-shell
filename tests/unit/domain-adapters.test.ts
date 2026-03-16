/**
 * Tests for Domain Adapters (echo, browser, wordpress, n8n)
 * Tests extractKnowledge, validate, queryExpansions, planNormalizers.
 * Does NOT test execute (requires live services).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EchoAdapter } from '../../domains/echo/adapter.js';
import { BrowserAdapter } from '../../domains/browser/adapter.js';
import { WordPressAdapter } from '../../domains/wordpress/adapter.js';
import { N8nAdapter } from '../../domains/n8n/adapter.js';
import type { ExecutionPlan } from '../../src/types/entities.js';

describe('EchoAdapter', () => {
  const adapter = new EchoAdapter();

  it('has correct id and name', () => {
    assert.equal(adapter.id, 'echo');
    assert.equal(adapter.name, 'Echo (Test Domain)');
  });

  it('extracts 7 Knowledge entities', async () => {
    const knowledge = await adapter.extractKnowledge();
    assert.equal(knowledge.length, 7);
    assert.ok(knowledge.every(k => k.type === 'knowledge'));
    assert.ok(knowledge.every(k => k.domainId === 'echo'));
  });

  it('validates a correct plan', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: 'Create', operationId: 'echo.items.create', params: { name: 'test' } }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('warns on unknown operations', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'echo.unknown.op', params: {} }],
    };
    const result = adapter.validate(plan);
    assert.ok(result.warnings.length > 0);
  });

  it('reports invalid dependency references', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'echo.items.create', params: {}, dependsOn: [99] }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('non-existent step')));
  });

  it('executes a plan successfully', async () => {
    const plan: ExecutionPlan = {
      goal: 'create two items',
      steps: [
        { stepId: 1, description: 'Create A', operationId: 'echo.items.create', params: { name: 'A' }, outputRef: 'itemA' },
        { stepId: 2, description: 'Create B', operationId: 'echo.items.create', params: { name: 'B', parentId: '{{itemA.id}}' }, dependsOn: [1] },
      ],
    };
    const result = await adapter.execute(plan);
    assert.equal(result.success, true);
    assert.equal(result.steps.length, 2);
    assert.ok(result.steps.every(s => s.success));
  });

  it('provides query expansions', () => {
    const expansions = adapter.queryExpansions!();
    assert.ok('create' in expansions);
    assert.ok('item' in expansions);
  });
});

describe('BrowserAdapter', () => {
  const adapter = new BrowserAdapter();

  it('has correct id and name', () => {
    assert.equal(adapter.id, 'browser');
    assert.ok(adapter.name.includes('Browser'));
  });

  it('extracts 16 Knowledge entities', async () => {
    const knowledge = await adapter.extractKnowledge();
    assert.equal(knowledge.length, 16);
    assert.ok(knowledge.every(k => k.domainId === 'browser'));
  });

  it('has operations for navigate, click, fill, screenshot', async () => {
    const knowledge = await adapter.extractKnowledge();
    const ops = knowledge.map(k => k.operationId);
    assert.ok(ops.includes('browser.navigate'));
    assert.ok(ops.includes('browser.click'));
    assert.ok(ops.includes('browser.fill'));
    assert.ok(ops.includes('browser.screenshot'));
  });

  it('validates correct plan', () => {
    const plan: ExecutionPlan = {
      goal: 'navigate',
      steps: [{ stepId: 1, description: 'Nav', operationId: 'browser.navigate', params: { url: 'https://example.com' } }],
    };
    assert.equal(adapter.validate(plan).valid, true);
  });

  it('provides query expansions', () => {
    const exp = adapter.queryExpansions!();
    assert.ok('browse' in exp);
    assert.ok('click' in exp);
    assert.ok('screenshot' in exp);
  });

  it('provides plan normalizers', () => {
    const normalizers = adapter.planNormalizers!();
    assert.ok(normalizers.length > 0);
  });

  it('plan normalizer fixes shorthand operationId', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'navigate', params: { url: 'https://x.com' } }],
    };
    const fixes: string[] = [];
    const normalizers = adapter.planNormalizers!();
    normalizers[0](plan, fixes);
    assert.equal(plan.steps[0].operationId, 'browser.navigate');
    assert.ok(fixes.length > 0);
  });

  it('plan normalizer moves value → url for navigate', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'browser.navigate', params: { value: 'https://x.com' } }],
    };
    const fixes: string[] = [];
    const normalizers = adapter.planNormalizers!();
    normalizers[0](plan, fixes);
    assert.equal(plan.steps[0].params.url, 'https://x.com');
    assert.equal(plan.steps[0].params.value, undefined);
  });
});

describe('WordPressAdapter', () => {
  const adapter = new WordPressAdapter();

  it('has correct id and name', () => {
    assert.equal(adapter.id, 'wordpress');
    assert.ok(adapter.name.includes('WordPress'));
  });

  it('extracts built-in Knowledge entities', async () => {
    const knowledge = await adapter.extractKnowledge();
    assert.ok(knowledge.length >= 18);
    assert.ok(knowledge.every(k => k.domainId === 'wordpress'));
  });

  it('has operations for posts, pages, categories, tags', async () => {
    const knowledge = await adapter.extractKnowledge();
    const ops = knowledge.map(k => k.operationId);
    assert.ok(ops.includes('POST:/wp/v2/posts'));
    assert.ok(ops.includes('GET:/wp/v2/posts'));
    assert.ok(ops.includes('POST:/wp/v2/pages'));
    assert.ok(ops.includes('POST:/wp/v2/categories'));
    assert.ok(ops.includes('POST:/wp/v2/tags'));
  });

  it('validates correct plan', () => {
    const plan: ExecutionPlan = {
      goal: 'create post',
      steps: [{ stepId: 1, description: 'Create', operationId: 'POST:/wp/v2/posts', params: { title: 'Test' } }],
    };
    assert.equal(adapter.validate(plan).valid, true);
  });

  it('provides query expansions', () => {
    const exp = adapter.queryExpansions!();
    assert.ok('post' in exp);
    assert.ok('category' in exp);
    assert.ok('woocommerce' in exp);
  });

  it('plan normalizer fixes PATCH → POST', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'PATCH:/wp/v2/posts/1', params: {} }],
    };
    const fixes: string[] = [];
    const normalizers = adapter.planNormalizers!();
    normalizers[0](plan, fixes);
    assert.ok(plan.steps[0].operationId.startsWith('POST:'));
    assert.ok(fixes.some(f => f.includes('PATCH')));
  });

  it('plan normalizer adds method prefix to bare paths', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: 'Create a post', operationId: '/wp/v2/posts', params: { title: 'Test' } }],
    };
    const fixes: string[] = [];
    const normalizers = adapter.planNormalizers!();
    normalizers[0](plan, fixes);
    assert.ok(plan.steps[0].operationId.includes(':'));
    assert.ok(fixes.some(f => f.includes('method prefix')));
  });

  it('plan normalizer wraps taxonomy numbers in arrays', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'POST:/wp/v2/posts', params: { categories: 5 } }],
    };
    const fixes: string[] = [];
    const normalizers = adapter.planNormalizers!();
    normalizers[0](plan, fixes);
    assert.deepEqual(plan.steps[0].params.categories, [5]);
  });

  it('plan normalizer converts WC taxonomy to object format', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'POST:/wc/v3/products', params: { categories: [42] } }],
    };
    const fixes: string[] = [];
    const normalizers = adapter.planNormalizers!();
    normalizers[0](plan, fixes);
    assert.deepEqual(plan.steps[0].params.categories, [{ id: 42 }]);
  });
});

describe('N8nAdapter', () => {
  const adapter = new N8nAdapter();

  it('has correct id and name', () => {
    assert.equal(adapter.id, 'n8n');
    assert.ok(adapter.name.includes('n8n'));
  });

  it('extracts built-in Knowledge entities', async () => {
    const knowledge = await adapter.extractKnowledge();
    assert.ok(knowledge.length >= 15);
    assert.ok(knowledge.every(k => k.domainId === 'n8n'));
  });

  it('has trigger, action, flow, and transform categories', async () => {
    const knowledge = await adapter.extractKnowledge();
    const categories = new Set(knowledge.map(k => k.category));
    assert.ok(categories.has('trigger'));
    assert.ok(categories.has('action'));
    assert.ok(categories.has('flow'));
    assert.ok(categories.has('transform'));
  });

  it('validates and warns about missing trigger', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [
        { stepId: 1, description: 'Set', operationId: 'n8n-nodes-base.set', params: {} },
      ],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, true); // Warning, not error
    assert.ok(result.warnings.some(w => w.includes('trigger')));
  });

  it('provides query expansions', () => {
    const exp = adapter.queryExpansions!();
    assert.ok('email' in exp);
    assert.ok('http' in exp);
    assert.ok('schedule' in exp);
  });

  it('plan normalizer fixes shorthand node types', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'webhook', params: {} }],
    };
    const fixes: string[] = [];
    const normalizers = adapter.planNormalizers!();
    normalizers[0](plan, fixes);
    assert.equal(plan.steps[0].operationId, 'n8n-nodes-base.webhook');
  });

  it('plan normalizer adds n8n- prefix', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'nodes-base.httpRequest', params: {} }],
    };
    const fixes: string[] = [];
    const normalizers = adapter.planNormalizers!();
    normalizers[0](plan, fixes);
    assert.equal(plan.steps[0].operationId, 'n8n-nodes-base.httpRequest');
  });

  it('composes a workflow from plan (no instance)', async () => {
    const plan: ExecutionPlan = {
      goal: 'Webhook that responds',
      steps: [
        { stepId: 1, description: 'Webhook', operationId: 'n8n-nodes-base.webhook', params: { path: '/test' } },
        { stepId: 2, description: 'Respond', operationId: 'n8n-nodes-base.respondToWebhook', params: {}, dependsOn: [1] },
      ],
    };
    const result = await adapter.execute(plan);
    assert.equal(result.success, true);
    assert.equal(result.steps.length, 1); // Single compose step
    assert.ok(result.steps[0].response); // Contains workflow JSON
    const workflow = result.steps[0].response as { name: string; nodes: unknown[]; connections: unknown };
    assert.equal(workflow.name, plan.goal);
    assert.ok(workflow.nodes.length >= 2);
  });
});
