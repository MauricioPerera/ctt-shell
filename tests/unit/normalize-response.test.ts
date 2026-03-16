/**
 * Tests for Response Normalizer (guardrails/normalize-response.ts)
 * Uses Node.js built-in test runner.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResponse, extractBestJson } from '../../src/guardrails/normalize-response.js';

describe('normalizeResponse', () => {
  it('parses clean JSON in code fence', () => {
    const raw = '```json\n{"goal": "test", "steps": []}\n```';
    const result = normalizeResponse(raw);
    assert.equal(result.json, '{"goal": "test", "steps": []}');
    assert.equal(result.fixes.length, 0);
  });

  it('parses JSON without code fence', () => {
    const raw = '{"goal": "test", "steps": []}';
    const result = normalizeResponse(raw);
    assert.notEqual(result.json, null);
    const parsed = JSON.parse(result.json!);
    assert.equal(parsed.goal, 'test');
  });

  it('strips thinking tags', () => {
    const raw = '<thinking>Let me think about this...</thinking>\n```json\n{"goal": "test", "steps": []}\n```';
    const result = normalizeResponse(raw);
    assert.notEqual(result.json, null);
    assert.ok(result.fixes.includes('stripped reasoning tags'));
  });

  it('strips <think> tags', () => {
    const raw = '<think>reasoning here</think>{"goal": "test", "steps": []}';
    const result = normalizeResponse(raw);
    assert.notEqual(result.json, null);
  });

  it('handles trailing commas', () => {
    const raw = '{"goal": "test", "steps": [{"stepId": 1,}],}';
    const result = normalizeResponse(raw);
    assert.notEqual(result.json, null);
    JSON.parse(result.json!); // Should not throw
    assert.ok(result.fixes.includes('removed trailing commas'));
  });

  it('handles single quotes', () => {
    const raw = "{'goal': 'test', 'steps': []}";
    const result = normalizeResponse(raw);
    assert.notEqual(result.json, null);
    const parsed = JSON.parse(result.json!);
    assert.equal(parsed.goal, 'test');
  });

  it('handles unquoted keys', () => {
    const raw = '{goal: "test", steps: []}';
    const result = normalizeResponse(raw);
    assert.notEqual(result.json, null);
    const parsed = JSON.parse(result.json!);
    assert.equal(parsed.goal, 'test');
  });

  it('handles unclosed code fence (truncated response)', () => {
    const raw = '```json\n{"goal": "test", "steps": [{"stepId": 1, "operationId": "echo.items.create", "params": {}}]}';
    const result = normalizeResponse(raw);
    assert.notEqual(result.json, null);
    assert.ok(result.fixes.some(f => f.includes('unclosed code fence')));
  });

  it('auto-closes truncated JSON with missing brackets', () => {
    const raw = '{"goal": "test", "steps": [{"stepId": 1, "operationId": "x", "params": {}}';
    const result = normalizeResponse(raw);
    assert.notEqual(result.json, null);
    const parsed = JSON.parse(result.json!);
    assert.equal(parsed.goal, 'test');
    assert.ok(result.fixes.includes('auto-closed truncated JSON'));
  });

  it('handles truncated JSON with dangling string — recovers to last complete object', () => {
    // The "},\n" separator allows autoCloseJson to find the last complete step
    const raw = '{"goal": "test", "steps": [{"stepId": 1, "operationId": "a", "params": {}, "description": "step 1"},\n{"stepId": 2, "operationId": "b", "params": {}, "description": "this is truncat';
    const result = normalizeResponse(raw);
    assert.notEqual(result.json, null);
    const parsed = JSON.parse(result.json!);
    assert.equal(parsed.goal, 'test');
    assert.ok(parsed.steps.length >= 1);
  });

  it('extracts JSON from raw text with surrounding prose', () => {
    const raw = 'Here is the plan:\n\n{"goal": "test", "steps": []}\n\nThat should work.';
    const result = normalizeResponse(raw);
    assert.notEqual(result.json, null);
    assert.ok(result.fixes.includes('extracted JSON from raw text'));
  });

  it('returns null for completely invalid input', () => {
    const raw = 'This is just text with no JSON at all.';
    const result = normalizeResponse(raw);
    assert.equal(result.json, null);
  });
});

describe('extractBestJson', () => {
  it('prefers block with goal + steps', () => {
    const raw = '```json\n{"name": "ignore"}\n```\n\n```json\n{"goal": "test", "steps": [{"stepId": 1}]}\n```';
    const result = extractBestJson(raw);
    assert.notEqual(result, null);
    const parsed = JSON.parse(result!);
    assert.equal(parsed.goal, 'test');
  });

  it('falls back to first parseable block', () => {
    const raw = '```json\n{"name": "first"}\n```\n\n```json\nbroken json\n```';
    const result = extractBestJson(raw);
    assert.notEqual(result, null);
    const parsed = JSON.parse(result!);
    assert.equal(parsed.name, 'first');
  });

  it('delegates to normalizeResponse when no code fences', () => {
    const raw = '{"goal": "test", "steps": []}';
    const result = extractBestJson(raw);
    assert.notEqual(result, null);
  });
});
