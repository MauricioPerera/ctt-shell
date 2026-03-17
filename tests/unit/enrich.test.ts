import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { enrichMemory, applyEnrichment, enrichMemories } from '../../src/agent/enrich.js';
import type { LlmProvider, LlmMessage, LlmResponse, LlmOptions } from '../../src/llm/provider.js';
import type { Memory } from '../../src/types/entities.js';

// Mock LLM that returns configurable responses based on prompt content
class MockEnrichLlm implements LlmProvider {
  name = 'mock-enrich';
  calls: string[] = [];

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const content = messages[messages.length - 1].content;
    this.calls.push(content);

    if (content.includes('Category')) {
      return { content: 'auth', model: 'mock', usage: { inputTokens: 10, outputTokens: 1 } };
    }
    if (content.includes('tags')) {
      return { content: '401, rest-api, forbidden, wordpress', model: 'mock', usage: { inputTokens: 10, outputTokens: 5 } };
    }
    if (content.includes('Severity')) {
      return { content: 'blocking', model: 'mock', usage: { inputTokens: 10, outputTokens: 1 } };
    }
    if (content.includes('fix')) {
      return { content: 'Regenerate application password', model: 'mock', usage: { inputTokens: 10, outputTokens: 3 } };
    }
    return { content: 'unknown', model: 'mock', usage: { inputTokens: 10, outputTokens: 1 } };
  }
}

function makeMemory(content: string): Memory {
  return {
    id: 'mem-1',
    type: 'memory',
    domainId: 'wordpress',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: ['auto-error', 'wordpress'],
    category: 'error',
    operationId: 'POST:/wp/v2/posts',
    content,
    relevance: 1.0,
  };
}

describe('Memory Enrichment', () => {
  let llm: MockEnrichLlm;

  beforeEach(() => {
    llm = new MockEnrichLlm();
  });

  describe('enrichMemory', () => {
    it('should classify, tag, and assess severity in parallel', async () => {
      const memory = makeMemory('401 rest_forbidden Sorry you are not allowed to create posts');
      const result = await enrichMemory(llm, memory);

      assert.strictEqual(result.category, 'error'); // 'auth' maps to 'error'
      assert.ok(result.tags.length > 0, 'should have tags');
      assert.ok(result.tags.includes('auth'), 'should include sub-category as tag');
      assert.strictEqual(result.severity, 'blocking');
      assert.strictEqual(result.enrichedBy, 'mock-enrich');
      assert.ok(result.enrichDurationMs >= 0);
    });

    it('should make 3 LLM calls without suggestFixes', async () => {
      const memory = makeMemory('Connection timeout after 30s');
      await enrichMemory(llm, memory);
      assert.strictEqual(llm.calls.length, 3);
    });

    it('should make 4 LLM calls with suggestFixes', async () => {
      const memory = makeMemory('Connection timeout after 30s');
      const result = await enrichMemory(llm, memory, { suggestFixes: true });
      assert.strictEqual(llm.calls.length, 4);
      assert.ok(result.suggestedFix);
    });

    it('should parse comma-separated tags', async () => {
      const memory = makeMemory('401 error');
      const result = await enrichMemory(llm, memory);
      // Mock returns '401, rest-api, forbidden, wordpress'
      assert.ok(result.tags.includes('401'));
      assert.ok(result.tags.includes('rest-api'));
      assert.ok(result.tags.includes('forbidden'));
    });

    it('should handle LLM errors gracefully', async () => {
      const failLlm: LlmProvider = {
        name: 'fail',
        async chat() { throw new Error('LLM offline'); },
      };
      const memory = makeMemory('Some error');
      const result = await enrichMemory(failLlm, memory);
      // Should return defaults, not throw
      assert.strictEqual(result.severity, 'blocking');
      assert.ok(Array.isArray(result.tags));
    });
  });

  describe('applyEnrichment', () => {
    it('should merge tags without duplicates', () => {
      const memory = makeMemory('test error');
      memory.tags = ['auto-error', 'wordpress'];

      applyEnrichment(memory, {
        category: 'error',
        tags: ['401', 'auth', 'wordpress'], // 'wordpress' is duplicate
        severity: 'blocking',
        enrichedBy: 'mock',
        enrichDurationMs: 100,
      });

      assert.ok(memory.tags.includes('401'));
      assert.ok(memory.tags.includes('auth'));
      assert.ok(memory.tags.includes('wordpress'));
      // No duplicates
      const unique = new Set(memory.tags);
      assert.strictEqual(unique.size, memory.tags.length);
    });

    it('should add suggestedFix as resolution if none exists', () => {
      const memory = makeMemory('test error');
      assert.strictEqual(memory.resolution, undefined);

      applyEnrichment(memory, {
        category: 'error',
        tags: ['test'],
        severity: 'recoverable',
        suggestedFix: 'Retry with backoff',
        enrichedBy: 'mock',
        enrichDurationMs: 50,
      });

      assert.strictEqual(memory.resolution, 'Retry with backoff');
    });

    it('should NOT overwrite existing resolution', () => {
      const memory = makeMemory('test error');
      memory.resolution = 'Existing fix';

      applyEnrichment(memory, {
        category: 'error',
        tags: ['test'],
        severity: 'recoverable',
        suggestedFix: 'New suggestion',
        enrichedBy: 'mock',
        enrichDurationMs: 50,
      });

      assert.strictEqual(memory.resolution, 'Existing fix');
    });
  });

  describe('enrichMemories (batch)', () => {
    it('should enrich multiple memories sequentially', async () => {
      const memories = [
        makeMemory('401 unauthorized'),
        makeMemory('404 not found'),
        makeMemory('500 internal server error'),
      ];

      const progress: number[] = [];
      const results = await enrichMemories(llm, memories, {
        onProgress: (i) => progress.push(i),
      });

      assert.strictEqual(results.length, 3);
      assert.deepStrictEqual(progress, [1, 2, 3]);
    });

    it('should apply enrichment to each memory', async () => {
      const memories = [makeMemory('timeout error')];
      const results = await enrichMemories(llm, memories);

      assert.ok(results[0].memory.tags.length > 2); // original 2 + enriched
      assert.ok(results[0].enrichment.enrichDurationMs >= 0);
    });
  });
});
