/**
 * Tests for MCP Server (src/mcp/server.ts)
 * Tests the JSON-RPC request handling logic without stdio transport.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../../src/mcp/server.js';

describe('McpServer', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer();
  });

  // ─── Protocol ─────────────────────────────────────────────────────────────

  it('responds to initialize with protocol version and capabilities', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} },
    });

    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.ok(res.result);
    const result = res.result as Record<string, unknown>;
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.ok(result.capabilities);
    const serverInfo = result.serverInfo as Record<string, string>;
    assert.equal(serverInfo.name, 'ctt-shell');
  });

  it('returns tool list with 8 tools', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const result = res.result as { tools: Array<{ name: string }> };
    assert.equal(result.tools.length, 8);
    const names = result.tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      'ctt_context',
      'ctt_execute',
      'ctt_extract',
      'ctt_list_domains',
      'ctt_recall',
      'ctt_search',
      'ctt_shell',
      'ctt_store_stats',
    ]);
  });

  it('returns error for unknown method', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'unknown/method',
    });

    assert.ok(res.error);
    assert.equal(res.error!.code, -32601);
    assert.ok(res.error!.message.includes('Method not found'));
  });

  // ─── Tools ────────────────────────────────────────────────────────────────

  it('ctt_list_domains returns 7 registered domains', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'ctt_list_domains', arguments: {} },
    });

    assert.ok(res.result);
    const result = res.result as { content: Array<{ type: string; text: string }> };
    assert.equal(result.content[0].type, 'text');
    const domains = JSON.parse(result.content[0].text) as Array<{ id: string; name: string }>;
    assert.equal(domains.length, 7);
    const ids = domains.map(d => d.id).sort();
    assert.deepEqual(ids, ['browser', 'echo', 'email', 'git', 'n8n', 'wordpress', 'wp-cli']);
  });

  it('ctt_store_stats returns entity counts', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'ctt_store_stats', arguments: {} },
    });

    const result = res.result as { content: Array<{ text: string }> };
    const stats = JSON.parse(result.content[0].text);
    assert.ok('knowledge' in stats);
    assert.ok('skill' in stats);
    assert.ok('memory' in stats);
    assert.ok('profile' in stats);
    assert.ok(Array.isArray(stats.domains));
  });

  it('ctt_extract extracts echo domain knowledge', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'ctt_extract', arguments: { domain: 'echo' } },
    });

    const result = res.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.domain, 'echo');
    assert.ok(data.extracted >= 7); // Echo has 7 operations
  });

  it('ctt_extract returns error for unknown domain', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'ctt_extract', arguments: { domain: 'nonexistent' } },
    });

    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Domain not found'));
  });

  it('ctt_search returns results after extraction', async () => {
    // First extract echo domain
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'ctt_extract', arguments: { domain: 'echo' } },
    });

    // Now search
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'ctt_search', arguments: { query: 'create item', limit: 5 } },
    });

    const result = res.result as { content: Array<{ text: string }> };
    const results = JSON.parse(result.content[0].text) as Array<{ operationId: string; score: number }>;
    assert.ok(results.length > 0);
    assert.ok(results[0].score > 0);
  });

  it('ctt_recall builds context for a goal', async () => {
    // Extract first
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'ctt_extract', arguments: { domain: 'echo' } },
    });

    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'ctt_recall', arguments: { goal: 'create an item', compact: false } },
    });

    const result = res.result as { content: Array<{ text: string }> };
    const ctx = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(ctx.knowledge));
    assert.ok(Array.isArray(ctx.skills));
    assert.ok(Array.isArray(ctx.memories));
    assert.ok(typeof ctx.prompt === 'string');
    assert.ok(ctx.prompt.length > 0);
  });

  it('returns error for unknown tool', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });

    assert.ok(res.error);
    assert.equal(res.error!.code, -32602);
    assert.ok(res.error!.message.includes('Unknown tool'));
  });

  // ─── Tool schemas ─────────────────────────────────────────────────────────

  it('all tools have valid inputSchema with type object', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/list',
    });

    const result = res.result as { tools: Array<{ name: string; inputSchema: { type: string; properties: Record<string, unknown> } }> };
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema type should be object`);
      assert.ok(tool.inputSchema.properties, `${tool.name} should have properties`);
    }
  });
});
