/**
 * Web API Routes for CTT-Shell
 *
 * REST endpoints that reuse the same infrastructure as MCP and CLI.
 * Zero runtime dependencies — uses only Node.js built-ins.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { Store } from '../storage/store.js';
import type { SearchEngine } from '../search/tfidf.js';
import type { DomainRegistry } from '../domain/registry.js';
import type { ContextLoader } from '../context/loader.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { AutonomousAgent } from '../agent/autonomous.js';
import { recall, contextToPrompt } from '../agent/recall.js';
import { CircuitBreaker } from '../guardrails/circuit-breaker.js';
import { createProvider } from '../llm/provider.js';
import type { ProviderType } from '../llm/provider.js';
import { describeCron } from '../scheduler/cron-parser.js';
import { createExecutor } from '../shell/executor.js';
import { AuditLog } from '../shell/audit.js';
import type { ShellRole } from '../shell/policy.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Infra {
  store: Store;
  search: SearchEngine;
  domains: DomainRegistry;
  contextLoader: ContextLoader;
  scheduler: Scheduler;
}

const CTT_ROOT = join(process.cwd(), '.ctt-shell');
const CONFIG_PATH = join(CTT_ROOT, 'config.json');

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadConfig(): Record<string, string> {
  const config: Record<string, string> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      Object.assign(config, JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')));
    } catch { /* ignore */ }
  }
  return config;
}

export function getLlmProvider(): { provider: ProviderType; config: Record<string, unknown> } | null {
  const cfg = loadConfig();
  const cfKey = process.env.CF_API_KEY || cfg.cfApiKey;
  const cfAccount = process.env.CF_ACCOUNT_ID || cfg.cfAccountId;

  if (process.env.ANTHROPIC_API_KEY) return { provider: 'claude', config: { apiKey: process.env.ANTHROPIC_API_KEY } };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', config: { apiKey: process.env.OPENAI_API_KEY } };
  if (cfKey && cfAccount) return { provider: 'cloudflare', config: { apiKey: cfKey, accountId: cfAccount, model: cfg.cfModel, gateway: cfg.cfGateway } };
  if (process.env.OLLAMA_MODEL) return { provider: 'ollama', config: { model: process.env.OLLAMA_MODEL } };
  if (process.env.LLAMACPP_PORT || cfg.llmProvider === 'llamacpp') return { provider: 'llamacpp', config: { model: cfg.llamacppModel, baseUrl: cfg.llamacppBaseUrl } };
  return null;
}

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function error(res: ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

function extractPathParam(path: string, index: number): string | undefined {
  const parts = path.split('/').filter(Boolean);
  return parts[index];
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function handleApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  infra: Infra,
): Promise<void> {
  const method = req.method ?? 'GET';

  try {
    // GET /api/domains
    if (path === '/api/domains' && method === 'GET') {
      const domains = infra.domains.list().map(id => {
        const adapter = infra.domains.get(id);
        const knowledge = infra.store.findBy('knowledge', (e) => e.domainId === id);
        return { id, name: adapter?.name ?? 'Unknown', knowledgeCount: knowledge.length };
      });
      json(res, domains);
      return;
    }

    // GET /api/stats
    if (path === '/api/stats' && method === 'GET') {
      const stats = infra.store.stats();
      json(res, { ...stats, domains: infra.domains.list() });
      return;
    }

    // POST /api/search
    if (path === '/api/search' && method === 'POST') {
      const body = await parseBody(req);
      const query = body.query as string;
      if (!query) { error(res, 'Missing "query" parameter'); return; }
      const limit = (body.limit as number) || 10;

      const results = infra.search.embeddingsEnabled
        ? await infra.search.hybridSearch(query, limit)
        : infra.search.search(query, limit);

      json(res, results.map(r => {
        const e = r.entity as unknown as Record<string, unknown>;
        return {
          score: Number(r.score.toFixed(3)),
          type: e.type,
          domainId: e.domainId,
          id: e.id,
          operationId: e.operationId ?? undefined,
          name: e.displayName ?? e.name ?? e.operationId ?? (e.content as string)?.slice(0, 80),
          description: (e.description as string)?.slice(0, 200) ?? (e.content as string)?.slice(0, 200),
          tags: e.tags,
        };
      }));
      return;
    }

    // POST /api/execute (SSE streaming)
    if (path === '/api/execute' && method === 'POST') {
      const body = await parseBody(req);
      const goal = body.goal as string;
      if (!goal) { error(res, 'Missing "goal" parameter'); return; }
      const domainId = body.domain as string | undefined;

      const llmConfig = getLlmProvider();
      if (!llmConfig) {
        error(res, 'No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, CF_API_KEY+CF_ACCOUNT_ID, or OLLAMA_MODEL.', 503);
        return;
      }

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const llm = createProvider(llmConfig.provider, llmConfig.config);
      const agent = new AutonomousAgent({
        store: infra.store,
        search: infra.search,
        domains: infra.domains,
        llm,
        onEvent: (evt) => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: 'event', event: { phase: evt.phase, message: evt.message, timestamp: evt.timestamp } })}\n\n`);
          }
        },
      });

      const result = await agent.run(goal, domainId);

      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({
          type: 'result',
          success: result.success,
          error: result.error,
          retries: result.retries,
          plan: result.plan ? {
            goal: result.plan.goal,
            steps: result.plan.steps.map(s => ({
              stepId: s.stepId,
              operationId: s.operationId,
              description: s.description,
            })),
          } : undefined,
          execution: result.result ? {
            success: result.result.success,
            durationMs: result.result.totalDurationMs,
            steps: result.result.steps.map(s => ({
              stepId: s.stepId,
              operationId: s.operationId,
              success: s.success,
              error: s.error,
            })),
          } : undefined,
        })}\n\n`);
        res.end();
      }
      return;
    }

    // POST /api/recall
    if (path === '/api/recall' && method === 'POST') {
      const body = await parseBody(req);
      const goal = body.goal as string;
      if (!goal) { error(res, 'Missing "goal" parameter'); return; }
      const compact = (body.compact as boolean) ?? false;
      const circuitBreaker = new CircuitBreaker(infra.store);
      const ctx = await recall(goal, infra.search, circuitBreaker, { compact });

      json(res, {
        knowledge: ctx.knowledge.map(k => ({
          operationId: k.operationId,
          displayName: k.displayName,
          category: k.category,
          domainId: k.domainId,
        })),
        skills: ctx.skills.map(s => ({
          name: s.name,
          goal: s.goal,
          status: s.status,
          stepCount: s.steps.length,
        })),
        memories: ctx.memories.map(m => ({
          category: m.category,
          content: m.content.slice(0, 200),
        })),
        prompt: contextToPrompt(ctx, compact),
      });
      return;
    }

    // POST /api/extract
    if (path === '/api/extract' && method === 'POST') {
      const body = await parseBody(req);
      const domainId = body.domain as string;
      if (!domainId) { error(res, 'Missing "domain" parameter'); return; }
      if (!infra.domains.has(domainId)) {
        error(res, `Domain not found: "${domainId}". Available: ${infra.domains.list().join(', ')}`, 404);
        return;
      }
      const count = await infra.domains.extractKnowledge(domainId);
      json(res, { domain: domainId, extracted: count });
      return;
    }

    // ─── Context CRUD ─────────────────────────────────────────────────────

    // GET /api/context
    if (path === '/api/context' && method === 'GET') {
      const entries = infra.contextLoader.list();
      json(res, {
        count: entries.length,
        entries: entries.map(e => ({
          id: e.id,
          title: e.displayName,
          category: e.category,
          preview: e.description.slice(0, 200),
          source: e.metadata?.source,
        })),
      });
      return;
    }

    // POST /api/context
    if (path === '/api/context' && method === 'POST') {
      const body = await parseBody(req);
      const text = body.text as string | undefined;
      const content = body.content as string | undefined;
      const filename = body.filename as string | undefined;
      const title = body.title as string | undefined;
      const category = body.category as string | undefined;
      const tags = (body.tags as string[]) || [];

      if (content && filename) {
        // File content upload (as JSON payload)
        const tmpDir = join(CTT_ROOT, 'tmp');
        if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
        const tmpPath = join(tmpDir, filename);
        writeFileSync(tmpPath, content, 'utf-8');
        const entries = infra.contextLoader.loadFile(tmpPath);
        infra.contextLoader.addToSearchIndex(entries);
        json(res, { count: entries.length, entries: entries.map(e => ({ id: e.id, title: e.displayName })) });
      } else if (text) {
        const entry = infra.contextLoader.addText(text, tags, category, title);
        infra.contextLoader.addToSearchIndex([entry]);
        json(res, { id: entry.id, title: entry.displayName });
      } else {
        error(res, 'Missing "text" or "content"+"filename" parameters');
      }
      return;
    }

    // DELETE /api/context/:id
    if (path.startsWith('/api/context/') && method === 'DELETE') {
      const id = extractPathParam(path, 2);
      if (!id) { error(res, 'Missing context ID'); return; }
      const removed = infra.contextLoader.remove(id);
      if (removed) infra.contextLoader.rebuildIndex();
      json(res, { removed, id });
      return;
    }

    // ─── Schedule CRUD ────────────────────────────────────────────────────

    // GET /api/schedule
    if (path === '/api/schedule' && method === 'GET') {
      const tasks = infra.scheduler.list();
      json(res, {
        count: tasks.length,
        tasks: tasks.map(t => ({
          id: t.id,
          cron: t.cron,
          description: describeCron(t.cron),
          goal: t.goal,
          domain: t.domainId,
          enabled: t.enabled,
          lastRunAt: t.lastRunAt,
          lastResult: t.lastResult,
          nextRunAt: t.nextRunAt,
          runCount: t.runCount,
          failCount: t.failCount,
        })),
      });
      return;
    }

    // POST /api/schedule
    if (path === '/api/schedule' && method === 'POST') {
      const body = await parseBody(req);
      const cron = body.cron as string;
      const goal = body.goal as string;
      if (!cron || !goal) { error(res, 'Missing "cron" and "goal" parameters'); return; }
      const domain = body.domain as string | undefined;
      try {
        const task = infra.scheduler.add(cron, goal, domain);
        json(res, {
          id: task.id,
          cron: task.cron,
          description: describeCron(task.cron),
          goal: task.goal,
          domain: task.domainId,
          nextRunAt: task.nextRunAt,
        });
      } catch (e) {
        error(res, e instanceof Error ? e.message : String(e));
      }
      return;
    }

    // PUT /api/schedule/:id
    if (path.startsWith('/api/schedule/') && method === 'PUT') {
      const id = extractPathParam(path, 2);
      if (!id) { error(res, 'Missing schedule ID'); return; }
      const body = await parseBody(req);
      const enabled = body.enabled as boolean | undefined;
      if (enabled !== undefined) {
        const ok = infra.scheduler.setEnabled(id, enabled);
        json(res, { id, enabled, updated: ok });
      } else {
        error(res, 'Missing "enabled" parameter');
      }
      return;
    }

    // DELETE /api/schedule/:id
    if (path.startsWith('/api/schedule/') && method === 'DELETE') {
      const id = extractPathParam(path, 2);
      if (!id) { error(res, 'Missing schedule ID'); return; }
      const removed = infra.scheduler.remove(id);
      json(res, { removed, id });
      return;
    }

    // ─── Shell ────────────────────────────────────────────────────────────

    // POST /api/shell
    if (path === '/api/shell' && method === 'POST') {
      const body = await parseBody(req);
      const command = body.command as string;
      if (!command) { error(res, 'Missing "command" parameter'); return; }
      const role = (body.role as ShellRole) || 'dev';
      const cwd = (body.cwd as string) || process.cwd();

      const audit = new AuditLog(join(CTT_ROOT, 'logs'));
      const executor = createExecutor(role, cwd, audit);
      const result = executor.exec(command);

      json(res, {
        executed: result.executed,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 50_000),
        stderr: result.stderr.slice(0, 10_000),
        durationMs: result.durationMs,
        command: result.command,
        role,
        denied: result.denyReason ? true : undefined,
        denyReason: result.denyReason,
      });
      return;
    }

    // ─── Config ───────────────────────────────────────────────────────────

    // GET /api/config
    if (path === '/api/config' && method === 'GET') {
      const cfg = loadConfig();
      json(res, {
        llmProvider: cfg.llmProvider || 'auto',
        cfModel: cfg.cfModel || '',
        cfGateway: cfg.cfGateway || '',
        ollamaModel: cfg.ollamaModel || '',
        llamacppModel: cfg.llamacppModel || '',
        llamacppBaseUrl: cfg.llamacppBaseUrl || '',
        // Show which env vars are set (without revealing values)
        envVars: {
          ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
          OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
          CF_API_KEY: !!(process.env.CF_API_KEY || cfg.cfApiKey),
          CF_ACCOUNT_ID: !!(process.env.CF_ACCOUNT_ID || cfg.cfAccountId),
          OLLAMA_MODEL: !!process.env.OLLAMA_MODEL,
          LLAMACPP_PORT: !!process.env.LLAMACPP_PORT,
        },
        activeLlm: getLlmProvider()?.provider ?? 'none',
      });
      return;
    }

    // PUT /api/config
    if (path === '/api/config' && method === 'PUT') {
      const body = await parseBody(req);
      const allowed = ['llmProvider', 'cfApiKey', 'cfAccountId', 'cfModel', 'cfGateway', 'ollamaModel', 'llamacppModel', 'llamacppBaseUrl'];
      const current = loadConfig();
      for (const key of allowed) {
        if (key in body) {
          const val = body[key] as string;
          if (val) current[key] = val;
          else delete current[key];
        }
      }
      if (!existsSync(CTT_ROOT)) mkdirSync(CTT_ROOT, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2));
      json(res, { saved: true, config: Object.fromEntries(allowed.map(k => [k, current[k] ? '***' : ''])) });
      return;
    }

    // Not found
    error(res, `Not found: ${method} ${path}`, 404);

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error(res, msg, msg === 'Invalid JSON body' ? 400 : 500);
  }
}
