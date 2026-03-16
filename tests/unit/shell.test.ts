/**
 * Tests for Shell Engine (src/shell/)
 * Tests parser, policy, executor, and audit.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseCommand, flattenPipeline, commandToString } from '../../src/shell/parser.js';
import { validateCommand, POLICIES } from '../../src/shell/policy.js';
import { ShellExecutor, createExecutor } from '../../src/shell/executor.js';
import { AuditLog } from '../../src/shell/audit.js';

// ─── Parser Tests ────────────────────────────────────────────────────────────

describe('ShellParser', () => {
  it('parses simple command', () => {
    const result = parseCommand('ls -la');
    assert.equal(result.command.binary, 'ls');
    assert.deepEqual(result.command.args, ['-la']);
    assert.equal(result.hasRedirect, false);
    assert.equal(result.hasBackground, false);
  });

  it('parses command with quoted arguments', () => {
    const result = parseCommand('git commit -m "hello world"');
    assert.equal(result.command.binary, 'git');
    assert.deepEqual(result.command.args, ['commit', '-m', 'hello world']);
  });

  it('parses single-quoted arguments', () => {
    const result = parseCommand("echo 'hello world'");
    assert.equal(result.command.binary, 'echo');
    assert.deepEqual(result.command.args, ['hello world']);
  });

  it('parses pipeline', () => {
    const result = parseCommand('cat file.txt | grep pattern | wc -l');
    const pipeline = flattenPipeline(result.command);
    assert.equal(pipeline.length, 3);
    assert.equal(pipeline[0].binary, 'cat');
    assert.equal(pipeline[1].binary, 'grep');
    assert.equal(pipeline[2].binary, 'wc');
  });

  it('parses environment variables', () => {
    const result = parseCommand('NODE_ENV=test node app.js');
    assert.equal(result.command.binary, 'node');
    assert.deepEqual(result.command.env, { NODE_ENV: 'test' });
  });

  it('detects redirects', () => {
    const result = parseCommand('echo hello > file.txt');
    assert.equal(result.hasRedirect, true);
    assert.ok(result.warnings.length > 0);
  });

  it('detects background operator', () => {
    const result = parseCommand('node server.js &');
    assert.equal(result.hasBackground, true);
  });

  it('does not split on || (logical OR)', () => {
    const result = parseCommand('test -f file.txt || echo missing');
    const pipeline = flattenPipeline(result.command);
    assert.equal(pipeline.length, 1); // Not split — treated as single command
  });

  it('reconstructs command string', () => {
    const result = parseCommand('git status --short');
    const str = commandToString(result.command);
    assert.equal(str, 'git status --short');
  });

  it('reconstructs pipeline string', () => {
    const result = parseCommand('ls -la | grep test');
    const str = commandToString(result.command);
    assert.equal(str, 'ls -la | grep test');
  });
});

// ─── Policy Tests ────────────────────────────────────────────────────────────

describe('ShellPolicy', () => {
  it('readonly allows ls', () => {
    const check = validateCommand('ls -la', POLICIES.readonly);
    assert.equal(check.allowed, true);
  });

  it('readonly allows git status', () => {
    const check = validateCommand('git status', POLICIES.readonly);
    assert.equal(check.allowed, true);
  });

  it('readonly blocks rm', () => {
    const check = validateCommand('rm file.txt', POLICIES.readonly);
    assert.equal(check.allowed, false);
    assert.ok(check.reason); // Blocked by allowedCommands or deniedPatterns
  });

  it('readonly blocks npm', () => {
    const check = validateCommand('npm install', POLICIES.readonly);
    assert.equal(check.allowed, false);
    assert.ok(check.reason?.includes('not in allowed list'));
  });

  it('dev allows git', () => {
    const check = validateCommand('git add .', POLICIES.dev);
    assert.equal(check.allowed, true);
  });

  it('dev allows node', () => {
    const check = validateCommand('node --version', POLICIES.dev);
    assert.equal(check.allowed, true);
  });

  it('dev blocks rm -rf /', () => {
    const check = validateCommand('rm -rf /', POLICIES.dev);
    assert.equal(check.allowed, false);
  });

  it('dev blocks sudo', () => {
    const check = validateCommand('sudo apt install', POLICIES.dev);
    assert.equal(check.allowed, false);
  });

  it('dev blocks git push --force', () => {
    const check = validateCommand('git push origin main --force', POLICIES.dev);
    assert.equal(check.allowed, false);
  });

  it('dev blocks npm publish', () => {
    const check = validateCommand('npm publish', POLICIES.dev);
    assert.equal(check.allowed, false);
  });

  it('admin allows most commands', () => {
    const check = validateCommand('docker ps', POLICIES.admin);
    assert.equal(check.allowed, true);
  });

  it('admin still blocks rm -rf /', () => {
    const check = validateCommand('rm -rf /', POLICIES.admin);
    assert.equal(check.allowed, false);
  });

  it('blocks empty command', () => {
    const check = validateCommand('', POLICIES.dev);
    assert.equal(check.allowed, false);
  });
});

// ─── Executor Tests ──────────────────────────────────────────────────────────

describe('ShellExecutor', () => {
  let executor: ShellExecutor;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ctt-shell-test-'));
    executor = createExecutor('dev', tmpDir);
  });

  it('executes a simple command', () => {
    const result = executor.exec('echo hello');
    assert.equal(result.executed, true);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('hello'));
  });

  it('captures exit code on failure', () => {
    const result = executor.exec('node -e "process.exit(42)"');
    assert.equal(result.executed, true);
    assert.equal(result.exitCode, 42);
  });

  it('denies blocked commands', () => {
    const result = executor.exec('sudo ls');
    assert.equal(result.executed, false);
    assert.equal(result.exitCode, 126);
    assert.ok(result.denyReason); // Blocked by policy
  });

  it('validates without executing', () => {
    const check = executor.validate('echo hello');
    assert.equal(check.allowed, true);

    const check2 = executor.validate('sudo rm -rf /');
    assert.equal(check2.allowed, false);
  });

  it('reports role', () => {
    assert.equal(executor.role, 'dev');
  });

  it('readonly executor blocks npm', () => {
    const roExecutor = createExecutor('readonly', tmpDir);
    const result = roExecutor.exec('npm install');
    assert.equal(result.executed, false);
    assert.ok(result.denyReason);
  });
});

// ─── Audit Tests ─────────────────────────────────────────────────────────────

describe('AuditLog', () => {
  let audit: AuditLog;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ctt-shell-audit-'));
    audit = new AuditLog(tmpDir);
  });

  it('records and reads entries', () => {
    audit.recordExecution('ls -la', 'dev', 0, 'file1\nfile2', '', 15);
    audit.recordDenied('sudo rm', 'readonly', 'blocked by policy');

    const entries = audit.tail(10);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].command, 'ls -la');
    assert.equal(entries[0].allowed, true);
    assert.equal(entries[1].command, 'sudo rm');
    assert.equal(entries[1].allowed, false);
  });

  it('counts entries', () => {
    audit.recordExecution('echo 1', 'dev', 0, '1', '', 5);
    audit.recordExecution('echo 2', 'dev', 0, '2', '', 5);
    assert.equal(audit.count(), 2);
  });

  it('returns stats', () => {
    audit.recordExecution('echo ok', 'dev', 0, 'ok', '', 5);
    audit.recordExecution('node bad.js', 'dev', 1, '', 'error', 10);
    audit.recordDenied('sudo ls', 'readonly', 'blocked');

    const stats = audit.stats();
    assert.equal(stats.total, 3);
    assert.equal(stats.allowed, 2);
    assert.equal(stats.denied, 1);
    assert.equal(stats.errors, 1);
  });

  it('creates log file on disk', () => {
    audit.recordExecution('test', 'dev', 0, '', '', 0);
    assert.ok(existsSync(join(tmpDir, 'shell-audit.jsonl')));
  });

  it('returns empty for non-existent log', () => {
    const newAudit = new AuditLog(join(tmpDir, 'nonexistent'));
    assert.deepEqual(newAudit.tail(), []);
    assert.equal(newAudit.count(), 0);
  });
});
