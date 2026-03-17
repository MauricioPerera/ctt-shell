/**
 * Tests for Domain Adapters (echo, browser, wordpress, n8n, wp-cli, git)
 * Tests extractKnowledge, validate, queryExpansions, planNormalizers.
 * Does NOT test execute (requires live services).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EchoAdapter } from '../../domains/echo/adapter.js';
import { BrowserAdapter } from '../../domains/browser/adapter.js';
import { WordPressAdapter } from '../../domains/wordpress/adapter.js';
import { N8nAdapter } from '../../domains/n8n/adapter.js';
import { WpCliAdapter } from '../../domains/wp-cli/adapter.js';
import { GitAdapter } from '../../domains/git/adapter.js';
import { EmailAdapter } from '../../domains/email/adapter.js';
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

// ─── WP-CLI Adapter ──────────────────────────────────────────────────────────

describe('WpCliAdapter', () => {
  const adapter = new WpCliAdapter({ cwd: process.cwd() });

  it('has correct id and name', () => {
    assert.equal(adapter.id, 'wp-cli');
    assert.equal(adapter.name, 'WordPress (WP-CLI)');
  });

  it('extracts 25 built-in Knowledge entities', async () => {
    const knowledge = await adapter.extractKnowledge();
    assert.ok(knowledge.length >= 25, `Expected ≥25 Knowledge, got ${knowledge.length}`);
    assert.ok(knowledge.every(k => k.type === 'knowledge'));
    assert.ok(knowledge.every(k => k.domainId === 'wp-cli'));
    assert.ok(knowledge.every(k => k.operationId.startsWith('wp.')));
  });

  it('Knowledge entities have required fields', async () => {
    const knowledge = await adapter.extractKnowledge();
    for (const k of knowledge) {
      assert.ok(k.id, 'Missing id');
      assert.ok(k.operationId, 'Missing operationId');
      assert.ok(k.displayName, 'Missing displayName');
      assert.ok(k.description, 'Missing description');
      assert.ok(k.category, 'Missing category');
      assert.ok(Array.isArray(k.tags), 'Tags should be array');
    }
  });

  it('validates a correct plan', () => {
    const plan: ExecutionPlan = {
      goal: 'Create a post',
      steps: [
        { stepId: 1, description: 'Create post', operationId: 'wp.post.create', params: { post_title: 'Hello' } },
      ],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('rejects operationIds without wp. prefix', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'post.create', params: {} }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('must start with "wp."')));
  });

  it('warns on unknown operations', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'wp.nonexistent.op', params: {} }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, true); // Unknown ops are warnings, not errors
    assert.ok(result.warnings.some(w => w.includes('unknown operation')));
  });

  it('warns on admin-only operations', () => {
    const plan: ExecutionPlan = {
      goal: 'Install plugin',
      steps: [{ stepId: 1, description: 'Install', operationId: 'wp.plugin.install', params: { _positional: 'woocommerce' } }],
    };
    const result = adapter.validate(plan);
    assert.ok(result.warnings.some(w => w.includes('admin privileges')));
  });

  it('reports invalid dependency references', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'wp.post.create', params: {}, dependsOn: [99] }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('non-existent step')));
  });

  it('provides query expansions', () => {
    const expansions = adapter.queryExpansions();
    assert.ok('post' in expansions);
    assert.ok('plugin' in expansions);
    assert.ok('database' in expansions);
    assert.ok('woocommerce' in expansions);
    assert.ok(expansions.post.includes('article'));
  });

  it('provides plan normalizers', () => {
    const normalizers = adapter.planNormalizers();
    assert.ok(normalizers.length >= 3, `Expected ≥3 normalizers, got ${normalizers.length}`);
  });

  it('normalizer: adds wp. prefix to bare operationIds', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'post create', params: {} }],
    };
    const fixes: string[] = [];
    normalizers[0](plan, fixes);
    assert.ok(plan.steps[0].operationId.startsWith('wp.'), `Expected wp. prefix, got "${plan.steps[0].operationId}"`);
  });

  it('normalizer: fixes hyphens and spaces in operationIds', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'wp.post-create', params: {} }],
    };
    const fixes: string[] = [];
    normalizers[1](plan, fixes);
    assert.ok(!plan.steps[0].operationId.includes('-') || plan.steps[0].operationId.includes('search-replace'));
  });

  it('normalizer: renames title→post_title for wp.post.create', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'wp.post.create', params: { title: 'Hello', content: 'World', status: 'publish' } }],
    };
    const fixes: string[] = [];
    normalizers[2](plan, fixes);
    assert.equal(plan.steps[0].params.post_title, 'Hello');
    assert.equal(plan.steps[0].params.post_content, 'World');
    assert.equal(plan.steps[0].params.post_status, 'publish');
    assert.equal(plan.steps[0].params.title, undefined);
  });

  it('normalizer: moves plugin name to positional arg', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'wp.plugin.install', params: { name: 'woocommerce' } }],
    };
    const fixes: string[] = [];
    normalizers[2](plan, fixes);
    assert.equal(plan.steps[0].params._positional, 'woocommerce');
    assert.equal(plan.steps[0].params.name, undefined);
  });
});

// ─── Git Adapter ─────────────────────────────────────────────────────────────

describe('GitAdapter', () => {
  const adapter = new GitAdapter({ cwd: process.cwd() });

  it('has correct id and name', () => {
    assert.equal(adapter.id, 'git');
    assert.equal(adapter.name, 'Git (CLI)');
  });

  it('extracts 28 built-in Knowledge entities', async () => {
    const knowledge = await adapter.extractKnowledge();
    assert.ok(knowledge.length >= 28, `Expected ≥28 Knowledge, got ${knowledge.length}`);
    assert.ok(knowledge.every(k => k.type === 'knowledge'));
    assert.ok(knowledge.every(k => k.domainId === 'git'));
    assert.ok(knowledge.every(k => k.operationId.startsWith('git.')));
  });

  it('Knowledge entities have required fields', async () => {
    const knowledge = await adapter.extractKnowledge();
    for (const k of knowledge) {
      assert.ok(k.id, 'Missing id');
      assert.ok(k.operationId, 'Missing operationId');
      assert.ok(k.displayName, 'Missing displayName');
      assert.ok(k.description, 'Missing description');
      assert.ok(k.category, 'Missing category');
      assert.ok(Array.isArray(k.tags), 'Tags should be array');
    }
  });

  it('Knowledge covers key categories', async () => {
    const knowledge = await adapter.extractKnowledge();
    const categories = new Set(knowledge.map(k => k.category));
    assert.ok(categories.has('setup'), 'Missing setup category');
    assert.ok(categories.has('staging'), 'Missing staging category');
    assert.ok(categories.has('branch'), 'Missing branch category');
    assert.ok(categories.has('remote'), 'Missing remote category');
    assert.ok(categories.has('history'), 'Missing history category');
    assert.ok(categories.has('merge'), 'Missing merge category');
    assert.ok(categories.has('stash'), 'Missing stash category');
    assert.ok(categories.has('tag'), 'Missing tag category');
    assert.ok(categories.has('undo'), 'Missing undo category');
  });

  it('validates a correct plan', () => {
    const plan: ExecutionPlan = {
      goal: 'Show status',
      steps: [
        { stepId: 1, description: 'Status', operationId: 'git.status', params: {} },
      ],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('rejects operationIds without git. prefix', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'commit', params: {} }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('must start with "git."')));
  });

  it('warns on unknown operations', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'git.nonexistent', params: {} }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some(w => w.includes('unknown operation')));
  });

  it('warns on destructive operations', () => {
    const plan: ExecutionPlan = {
      goal: 'Reset',
      steps: [{ stepId: 1, description: '', operationId: 'git.reset', params: { hard: true } }],
    };
    const result = adapter.validate(plan);
    assert.ok(result.warnings.some(w => w.includes('destructive')));
  });

  it('reports invalid dependency references', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'git.status', params: {}, dependsOn: [99] }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('non-existent step')));
  });

  it('provides query expansions', () => {
    const expansions = adapter.queryExpansions();
    assert.ok('commit' in expansions);
    assert.ok('branch' in expansions);
    assert.ok('merge' in expansions);
    assert.ok('push' in expansions);
    assert.ok('stash' in expansions);
    assert.ok(expansions.commit.includes('save'));
  });

  it('provides plan normalizers', () => {
    const normalizers = adapter.planNormalizers();
    assert.ok(normalizers.length >= 3, `Expected ≥3 normalizers, got ${normalizers.length}`);
  });

  it('normalizer: adds git. prefix to bare operationIds', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'commit', params: {} }],
    };
    const fixes: string[] = [];
    normalizers[0](plan, fixes);
    assert.ok(plan.steps[0].operationId.startsWith('git.'), `Expected git. prefix, got "${plan.steps[0].operationId}"`);
  });

  it('normalizer: fixes spaces in operationIds', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'git.branch create', params: {} }],
    };
    const fixes: string[] = [];
    normalizers[1](plan, fixes);
    assert.equal(plan.steps[0].operationId, 'git.branch.create');
  });

  it('normalizer: renames msg→message for commit', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'git.commit', params: { msg: 'hello' } }],
    };
    const fixes: string[] = [];
    normalizers[2](plan, fixes);
    assert.equal(plan.steps[0].params.message, 'hello');
    assert.equal(plan.steps[0].params.msg, undefined);
  });

  it('normalizer: renames m→message for commit', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'git.commit', params: { m: 'hello' } }],
    };
    const fixes: string[] = [];
    normalizers[2](plan, fixes);
    assert.equal(plan.steps[0].params.message, 'hello');
    assert.equal(plan.steps[0].params.m, undefined);
  });

  it('normalizer: renames branch→name for branch.create', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'git.branch.create', params: { branch: 'feature-x' } }],
    };
    const fixes: string[] = [];
    normalizers[2](plan, fixes);
    assert.equal(plan.steps[0].params.name, 'feature-x');
    assert.equal(plan.steps[0].params.branch, undefined);
  });

  it('normalizer: renames repo→url for clone', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'git.clone', params: { repo: 'https://github.com/test/test.git' } }],
    };
    const fixes: string[] = [];
    normalizers[2](plan, fixes);
    assert.equal(plan.steps[0].params.url, 'https://github.com/test/test.git');
    assert.equal(plan.steps[0].params.repo, undefined);
  });

  it('normalizer: renames file→files for git.add', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'git.add', params: { file: 'index.ts' } }],
    };
    const fixes: string[] = [];
    normalizers[2](plan, fixes);
    assert.equal(plan.steps[0].params.files, 'index.ts');
    assert.equal(plan.steps[0].params.file, undefined);
  });
});

// ─── Email Adapter ────────────────────────────────────────────────────────────

describe('EmailAdapter', () => {
  const adapter = new EmailAdapter({ cwd: process.cwd() });

  it('has correct id and name', () => {
    assert.equal(adapter.id, 'email');
    assert.equal(adapter.name, 'Email (Himalaya CLI)');
  });

  it('extracts 15 built-in Knowledge entities', async () => {
    const knowledge = await adapter.extractKnowledge();
    assert.ok(knowledge.length >= 15, `Expected ≥15 Knowledge, got ${knowledge.length}`);
    assert.ok(knowledge.every(k => k.type === 'knowledge'));
    assert.ok(knowledge.every(k => k.domainId === 'email'));
    assert.ok(knowledge.every(k => k.operationId.startsWith('email.')));
  });

  it('Knowledge entities have required fields', async () => {
    const knowledge = await adapter.extractKnowledge();
    for (const k of knowledge) {
      assert.ok(k.id, 'Missing id');
      assert.ok(k.operationId, 'Missing operationId');
      assert.ok(k.displayName, 'Missing displayName');
      assert.ok(k.description, 'Missing description');
      assert.ok(k.category, 'Missing category');
      assert.ok(Array.isArray(k.tags), 'Tags should be array');
    }
  });

  it('Knowledge covers key categories', async () => {
    const knowledge = await adapter.extractKnowledge();
    const categories = new Set(knowledge.map(k => k.category));
    assert.ok(categories.has('folder'), 'Missing folder category');
    assert.ok(categories.has('envelope'), 'Missing envelope category');
    assert.ok(categories.has('message'), 'Missing message category');
    assert.ok(categories.has('flag'), 'Missing flag category');
    assert.ok(categories.has('attachment'), 'Missing attachment category');
  });

  it('validates a correct plan', () => {
    const plan: ExecutionPlan = {
      goal: 'List folders',
      steps: [
        { stepId: 1, description: 'List folders', operationId: 'email.folder.list', params: {} },
      ],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('rejects operationIds without email. prefix', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'message.read', params: {} }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('must start with "email."')));
  });

  it('warns on unknown operations', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'email.nonexistent', params: {} }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some(w => w.includes('unknown operation')));
  });

  it('warns on destructive operations', () => {
    const plan: ExecutionPlan = {
      goal: 'Delete email',
      steps: [{ stepId: 1, description: '', operationId: 'email.message.delete', params: { id: '42' } }],
    };
    const result = adapter.validate(plan);
    assert.ok(result.warnings.some(w => w.includes('destructive')));
  });

  it('validates required params for send', () => {
    const plan: ExecutionPlan = {
      goal: 'Send email',
      steps: [{ stepId: 1, description: '', operationId: 'email.message.send', params: { subject: 'Hi' } }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('requires "to"')));
  });

  it('validates required params for read', () => {
    const plan: ExecutionPlan = {
      goal: 'Read email',
      steps: [{ stepId: 1, description: '', operationId: 'email.message.read', params: {} }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('requires "id"')));
  });

  it('reports invalid dependency references', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'email.folder.list', params: {}, dependsOn: [99] }],
    };
    const result = adapter.validate(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('non-existent step')));
  });

  it('provides query expansions', () => {
    const expansions = adapter.queryExpansions();
    assert.ok('email' in expansions);
    assert.ok('send' in expansions);
    assert.ok('read' in expansions);
    assert.ok('folder' in expansions);
    assert.ok('flag' in expansions);
    assert.ok(expansions.email.includes('mail'));
    assert.ok(expansions.email.includes('correo'));
  });

  it('provides plan normalizers', () => {
    const normalizers = adapter.planNormalizers();
    assert.ok(normalizers.length >= 3, `Expected ≥3 normalizers, got ${normalizers.length}`);
  });

  it('normalizer: adds email. prefix to bare operationIds', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'message.read', params: {} }],
    };
    const fixes: string[] = [];
    normalizers[0](plan, fixes);
    assert.ok(plan.steps[0].operationId.startsWith('email.'), `Expected email. prefix, got "${plan.steps[0].operationId}"`);
  });

  it('normalizer: expands shorthand "read" to full operationId', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'read', params: {} }],
    };
    const fixes: string[] = [];
    normalizers[0](plan, fixes);
    assert.equal(plan.steps[0].operationId, 'email.message.read');
  });

  it('normalizer: expands shorthand "send" to full operationId', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'send', params: {} }],
    };
    const fixes: string[] = [];
    normalizers[0](plan, fixes);
    assert.equal(plan.steps[0].operationId, 'email.message.send');
  });

  it('normalizer: fixes spaces in operationIds', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'email.message read', params: {} }],
    };
    const fixes: string[] = [];
    normalizers[1](plan, fixes);
    assert.equal(plan.steps[0].operationId, 'email.message.read');
  });

  it('normalizer: renames recipient→to for send', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'email.message.send', params: { recipient: 'test@x.com', title: 'Hello', content: 'World' } }],
    };
    const fixes: string[] = [];
    normalizers[2](plan, fixes);
    assert.equal(plan.steps[0].params.to, 'test@x.com');
    assert.equal(plan.steps[0].params.subject, 'Hello');
    assert.equal(plan.steps[0].params.body, 'World');
    assert.equal(plan.steps[0].params.recipient, undefined);
    assert.equal(plan.steps[0].params.title, undefined);
    assert.equal(plan.steps[0].params.content, undefined);
  });

  it('normalizer: renames message_id→id for read', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'email.message.read', params: { message_id: '42' } }],
    };
    const fixes: string[] = [];
    normalizers[2](plan, fixes);
    assert.equal(plan.steps[0].params.id, '42');
    assert.equal(plan.steps[0].params.message_id, undefined);
  });

  it('normalizer: renames destination→target for move', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'email.message.move', params: { id: '42', destination: 'Archive' } }],
    };
    const fixes: string[] = [];
    normalizers[2](plan, fixes);
    assert.equal(plan.steps[0].params.target, 'Archive');
    assert.equal(plan.steps[0].params.destination, undefined);
  });

  it('normalizer: renames flag→flags for flag ops', () => {
    const normalizers = adapter.planNormalizers();
    const plan: ExecutionPlan = {
      goal: 'test',
      steps: [{ stepId: 1, description: '', operationId: 'email.flag.add', params: { id: '42', flag: 'Seen' } }],
    };
    const fixes: string[] = [];
    normalizers[2](plan, fixes);
    assert.equal(plan.steps[0].params.flags, 'Seen');
    assert.equal(plan.steps[0].params.flag, undefined);
  });
});
