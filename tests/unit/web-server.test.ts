/**
 * Tests for Web Server (src/web/server.ts + src/web/routes.ts)
 * Tests the HTTP request handling logic directly without starting a listener.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { WebServer } from '../../src/web/server.js';

// ─── Mock Helpers ────────────────────────────────────────────────────────────

function createMockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:3700', 'content-type': 'application/json' };

  if (body) {
    process.nextTick(() => {
      stream.end(JSON.stringify(body));
    });
  } else {
    process.nextTick(() => stream.end());
  }

  return req;
}

interface MockRes {
  res: ServerResponse;
  statusCode: () => number;
  headers: () => Record<string, string | string[] | undefined>;
  body: () => string;
}

function createMockRes(): MockRes {
  const chunks: Buffer[] = [];
  let status = 200;
  let ended = false;
  const hdrs: Record<string, string | string[] | undefined> = {};

  // Use a plain object to avoid PassThrough's read-only writableEnded getter
  const mock: Record<string, unknown> = {
    writableEnded: false,
    writeHead(code: number, headers?: Record<string, string | string[] | undefined>) {
      status = code;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          hdrs[k.toLowerCase()] = v;
        }
      }
      return mock;
    },
    setHeader(name: string, value: string) {
      hdrs[name.toLowerCase()] = value;
      return mock;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      mock.writableEnded = true;
    },
  };
  const res = mock as unknown as ServerResponse;

  return {
    res,
    statusCode: () => status,
    headers: () => hdrs,
    body: () => Buffer.concat(chunks).toString('utf-8'),
  };
}

function parseJsonBody(mock: MockRes): unknown {
  return JSON.parse(mock.body());
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WebServer', () => {
  let server: WebServer;

  beforeEach(() => {
    server = new WebServer();
  });

  // ─── Static Routes ───────────────────────────────────────────────────────

  describe('static routes', () => {
    it('GET / returns HTML', async () => {
      const req = createMockReq('GET', '/');
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      assert.ok(mock.headers()['content-type']?.toString().includes('text/html'));
      assert.ok(mock.body().includes('CTT-Shell'));
    });

    it('GET /unknown returns 404', async () => {
      const req = createMockReq('GET', '/unknown');
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 404);
    });

    it('OPTIONS returns 204 (CORS preflight)', async () => {
      const req = createMockReq('OPTIONS', '/api/domains');
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 204);
    });
  });

  // ─── Domains ──────────────────────────────────────────────────────────────

  describe('GET /api/domains', () => {
    it('returns 7 registered domains', async () => {
      const req = createMockReq('GET', '/api/domains');
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as Array<{ id: string; name: string; knowledgeCount: number }>;
      assert.equal(data.length, 7);
      const ids = data.map(d => d.id).sort();
      assert.deepEqual(ids, ['browser', 'echo', 'email', 'git', 'n8n', 'wordpress', 'wp-cli']);
    });

    it('each domain has name and knowledgeCount', async () => {
      const req = createMockReq('GET', '/api/domains');
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      const data = parseJsonBody(mock) as Array<{ id: string; name: string; knowledgeCount: number }>;
      for (const d of data) {
        assert.ok(d.name, `domain ${d.id} should have name`);
        assert.equal(typeof d.knowledgeCount, 'number');
      }
    });
  });

  // ─── Stats ────────────────────────────────────────────────────────────────

  describe('GET /api/stats', () => {
    it('returns entity counts and domains', async () => {
      const req = createMockReq('GET', '/api/stats');
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as Record<string, unknown>;
      assert.ok('knowledge' in data);
      assert.ok('skill' in data);
      assert.ok('memory' in data);
      assert.ok('profile' in data);
      assert.ok(Array.isArray(data.domains));
    });
  });

  // ─── Search ───────────────────────────────────────────────────────────────

  describe('POST /api/search', () => {
    it('returns results after domain extraction', async () => {
      // Extract echo first
      const extractReq = createMockReq('POST', '/api/extract', { domain: 'echo' });
      const extractMock = createMockRes();
      await server.handleRequest(extractReq, extractMock.res);

      // Search
      const req = createMockReq('POST', '/api/search', { query: 'create item', limit: 5 });
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const results = parseJsonBody(mock) as Array<{ score: number }>;
      assert.ok(results.length > 0);
      assert.ok(results[0].score > 0);
    });

    it('returns error for missing query', async () => {
      const req = createMockReq('POST', '/api/search', {});
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 400);
    });
  });

  // ─── Extract ──────────────────────────────────────────────────────────────

  describe('POST /api/extract', () => {
    it('extracts echo domain knowledge', async () => {
      const req = createMockReq('POST', '/api/extract', { domain: 'echo' });
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as { domain: string; extracted: number };
      assert.equal(data.domain, 'echo');
      assert.ok(data.extracted >= 7);
    });

    it('returns 404 for unknown domain', async () => {
      const req = createMockReq('POST', '/api/extract', { domain: 'nonexistent' });
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 404);
    });
  });

  // ─── Recall ───────────────────────────────────────────────────────────────

  describe('POST /api/recall', () => {
    it('builds context for a goal', async () => {
      // Extract echo first
      const extractReq = createMockReq('POST', '/api/extract', { domain: 'echo' });
      const extractMock = createMockRes();
      await server.handleRequest(extractReq, extractMock.res);

      const req = createMockReq('POST', '/api/recall', { goal: 'create an item' });
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as { knowledge: unknown[]; skills: unknown[]; memories: unknown[]; prompt: string };
      assert.ok(Array.isArray(data.knowledge));
      assert.ok(typeof data.prompt === 'string');
      assert.ok(data.prompt.length > 0);
    });
  });

  // ─── Context CRUD ─────────────────────────────────────────────────────────

  describe('context CRUD', () => {
    it('POST /api/context adds text entry', async () => {
      const req = createMockReq('POST', '/api/context', { text: 'Test context', title: 'Test', category: 'test' });
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as { id: string; title: string };
      assert.ok(data.id);
      assert.ok(data.title);
    });

    it('GET /api/context lists entries', async () => {
      // Add one first
      const addReq = createMockReq('POST', '/api/context', { text: 'List test context' });
      const addMock = createMockRes();
      await server.handleRequest(addReq, addMock.res);

      const req = createMockReq('GET', '/api/context');
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as { count: number; entries: unknown[] };
      assert.ok(data.count >= 0);
      assert.ok(Array.isArray(data.entries));
    });

    it('DELETE /api/context/:id removes entry', async () => {
      // Add then delete
      const addReq = createMockReq('POST', '/api/context', { text: 'Delete test', title: 'To Delete' });
      const addMock = createMockRes();
      await server.handleRequest(addReq, addMock.res);
      const { id } = parseJsonBody(addMock) as { id: string };

      const req = createMockReq('DELETE', `/api/context/${id}`);
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as { removed: boolean };
      assert.ok(data.removed);
    });
  });

  // ─── Schedule CRUD ────────────────────────────────────────────────────────

  describe('schedule CRUD', () => {
    it('POST /api/schedule adds task', async () => {
      const req = createMockReq('POST', '/api/schedule', { cron: '0 9 * * *', goal: 'test goal' });
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as { id: string; cron: string; description: string };
      assert.ok(data.id);
      assert.equal(data.cron, '0 9 * * *');
      assert.ok(data.description);
    });

    it('GET /api/schedule lists tasks', async () => {
      const req = createMockReq('GET', '/api/schedule');
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as { count: number; tasks: unknown[] };
      assert.ok(typeof data.count === 'number');
      assert.ok(Array.isArray(data.tasks));
    });

    it('PUT /api/schedule/:id toggles enabled', async () => {
      // Add task first
      const addReq = createMockReq('POST', '/api/schedule', { cron: '@hourly', goal: 'toggle test' });
      const addMock = createMockRes();
      await server.handleRequest(addReq, addMock.res);
      const { id } = parseJsonBody(addMock) as { id: string };

      // Disable
      const req = createMockReq('PUT', `/api/schedule/${id}`, { enabled: false });
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as { id: string; enabled: boolean; updated: boolean };
      assert.equal(data.enabled, false);
    });

    it('DELETE /api/schedule/:id removes task', async () => {
      // Add then remove
      const addReq = createMockReq('POST', '/api/schedule', { cron: '@daily', goal: 'delete test' });
      const addMock = createMockRes();
      await server.handleRequest(addReq, addMock.res);
      const { id } = parseJsonBody(addMock) as { id: string };

      const req = createMockReq('DELETE', `/api/schedule/${id}`);
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as { removed: boolean };
      assert.ok(data.removed);
    });
  });

  // ─── Config ───────────────────────────────────────────────────────────────

  describe('config', () => {
    it('GET /api/config returns config with env vars status', async () => {
      const req = createMockReq('GET', '/api/config');
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 200);
      const data = parseJsonBody(mock) as { activeLlm: string; envVars: Record<string, boolean> };
      assert.ok('activeLlm' in data);
      assert.ok('envVars' in data);
      assert.ok('ANTHROPIC_API_KEY' in data.envVars);
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns 400 for invalid JSON body', async () => {
      const stream = new PassThrough();
      const req = stream as unknown as IncomingMessage;
      req.method = 'POST';
      req.url = '/api/search';
      req.headers = { host: 'localhost', 'content-type': 'application/json' };
      process.nextTick(() => stream.end('not-json{'));

      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 400);
    });

    it('returns 404 for unknown API route', async () => {
      const req = createMockReq('GET', '/api/unknown');
      const mock = createMockRes();
      await server.handleRequest(req, mock.res);
      assert.equal(mock.statusCode(), 404);
    });
  });
});
