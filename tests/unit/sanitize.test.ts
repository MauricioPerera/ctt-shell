/**
 * Tests for Secret Sanitization (guardrails/sanitize.ts)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeSecrets,
  resolveSecrets,
  isSensitiveParam,
  sanitizeParameters,
} from '../../src/guardrails/sanitize.js';

describe('Sanitize', () => {
  // ─── Layer 1: Known secrets map ──────────────────────────────────────────

  it('replaces known secrets with placeholders', () => {
    const secrets = new Map([['API_KEY', 'my-secret-key-12345']]);
    const result = sanitizeSecrets('Authorization: my-secret-key-12345', secrets);
    assert.equal(result, 'Authorization: {{API_KEY}}');
  });

  it('skips short secret values (< 4 chars)', () => {
    const secrets = new Map([['PIN', 'abc']]);
    const result = sanitizeSecrets('pin=abc', secrets);
    assert.equal(result, 'pin=abc');
  });

  it('replaces multiple occurrences of same secret', () => {
    const secrets = new Map([['TOKEN', 'mytoken1234']]);
    const result = sanitizeSecrets('first: mytoken1234, second: mytoken1234', secrets);
    assert.equal(result, 'first: {{TOKEN}}, second: {{TOKEN}}');
  });

  // ─── Layer 2: URL auth parameters ───────────────────────────────────────

  it('redacts URL query auth parameters', () => {
    const result = sanitizeSecrets('https://api.example.com?apikey=abcdefghij&name=test');
    assert.ok(result.includes('{{APIKEY}}'));
    assert.ok(result.includes('name=test'));
  });

  it('redacts access_token in URL', () => {
    const result = sanitizeSecrets('https://api.com?access_token=very-long-token-value');
    assert.ok(result.includes('{{ACCESS_TOKEN}}'));
  });

  it('redacts token after & separator', () => {
    const result = sanitizeSecrets('https://api.com?foo=bar&token=secretvalue1234');
    assert.ok(result.includes('{{TOKEN}}'));
    assert.ok(result.includes('foo=bar'));
  });

  // ─── Layer 3: JSON credential fields ────────────────────────────────────

  it('redacts JSON authorization field', () => {
    const result = sanitizeSecrets('{"authorization": "Bearer sk-ant-1234567890abcdef"}');
    assert.ok(result.includes('{{AUTHORIZATION}}'));
    assert.ok(!result.includes('sk-ant'));
  });

  it('redacts JSON api_key field', () => {
    const result = sanitizeSecrets('{"api_key": "some-long-api-key-value"}');
    assert.ok(result.includes('{{API_KEY}}'));
  });

  it('redacts JSON password field', () => {
    const result = sanitizeSecrets('{"password": "supersecretpass"}');
    assert.ok(result.includes('{{PASSWORD}}'));
  });

  // ─── Layer 4: Known credential prefixes ─────────────────────────────────

  it('redacts sk- prefixed keys', () => {
    const result = sanitizeSecrets('key: sk-1234567890abcdefghij1234');
    assert.ok(result.includes('{{REDACTED_SK}}'));
    assert.ok(!result.includes('sk-1234'));
  });

  it('redacts ghp_ prefixed tokens', () => {
    const result = sanitizeSecrets('token: ghp_abcdefghijklmnopqrstuv');
    assert.ok(result.includes('{{REDACTED_GHP}}'));
  });

  it('redacts Bearer tokens', () => {
    const result = sanitizeSecrets('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef');
    assert.ok(result.includes('{{REDACTED_BEARER}}'));
  });

  it('redacts JWT tokens (eyJ prefix)', () => {
    const result = sanitizeSecrets('token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature');
    assert.ok(result.includes('{{REDACTED_EYJ}}'));
  });

  // ─── resolveSecrets ─────────────────────────────────────────────────────

  it('resolves placeholders back to values', () => {
    const secrets = new Map([['API_KEY', 'real-key-123']]);
    const result = resolveSecrets('auth: {{API_KEY}}', secrets);
    assert.equal(result, 'auth: real-key-123');
  });

  it('round-trips sanitize → resolve', () => {
    const secrets = new Map([['MY_SECRET', 'very-secret-value-12345']]);
    const original = 'Connect with very-secret-value-12345';
    const sanitized = sanitizeSecrets(original, secrets);
    const resolved = resolveSecrets(sanitized, secrets);
    assert.equal(resolved, original);
  });

  // ─── isSensitiveParam ──────────────────────────────────────────────────

  it('detects known sensitive param names', () => {
    assert.ok(isSensitiveParam('apikey'));
    assert.ok(isSensitiveParam('api_key'));
    assert.ok(isSensitiveParam('apiKey'));
    assert.ok(isSensitiveParam('token'));
    assert.ok(isSensitiveParam('password'));
    assert.ok(isSensitiveParam('authorization'));
    assert.ok(isSensitiveParam('private_key'));
  });

  it('rejects non-sensitive param names', () => {
    assert.ok(!isSensitiveParam('name'));
    assert.ok(!isSensitiveParam('url'));
    assert.ok(!isSensitiveParam('title'));
    assert.ok(!isSensitiveParam('content'));
  });

  // ─── sanitizeParameters ─────────────────────────────────────────────────

  it('sanitizes sensitive parameter values', () => {
    const result = sanitizeParameters({
      name: 'test',
      apiKey: 'secret-key-12345',
      url: 'https://example.com',
    });
    assert.equal(result.name, 'test');
    assert.equal(result.apiKey, '{{APIKEY}}');
    assert.equal(result.url, 'https://example.com');
  });

  it('sanitizes nested objects', () => {
    const result = sanitizeParameters({
      config: {
        password: 'mysecretpass',
        host: 'localhost',
      },
    });
    const config = result.config as Record<string, unknown>;
    assert.equal(config.password, '{{PASSWORD}}');
    assert.equal(config.host, 'localhost');
  });

  it('applies credential prefix detection to string values', () => {
    const result = sanitizeParameters({
      header: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh',
    });
    assert.ok((result.header as string).includes('{{REDACTED_BEARER}}'));
  });

  it('preserves non-string values', () => {
    const result = sanitizeParameters({
      count: 42,
      enabled: true,
      items: [1, 2, 3],
    });
    assert.equal(result.count, 42);
    assert.equal(result.enabled, true);
    assert.deepEqual(result.items, [1, 2, 3]);
  });

  it('uses secrets map in sanitizeParameters', () => {
    const secrets = new Map([['DB_PASS', 'mydbpassword123']]);
    const result = sanitizeParameters(
      { connStr: 'host=db password=mydbpassword123' },
      secrets,
    );
    assert.ok((result.connStr as string).includes('{{DB_PASS}}'));
  });
});
