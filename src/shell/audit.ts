/**
 * Shell Audit — immutable log of all command executions.
 *
 * Every command the LLM executes gets recorded with:
 * - What was requested
 * - What policy was applied
 * - Whether it was allowed/denied
 * - The result (exit code, truncated output)
 * - Timing
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ShellRole } from './policy.js';

export interface AuditEntry {
  /** ISO timestamp */
  timestamp: string;
  /** The raw command string */
  command: string;
  /** Role that was applied */
  role: ShellRole;
  /** Whether the command was allowed to execute */
  allowed: boolean;
  /** If denied, the reason */
  denyReason?: string;
  /** Exit code (undefined if not executed) */
  exitCode?: number;
  /** First N chars of stdout */
  stdoutPreview?: string;
  /** First N chars of stderr */
  stderrPreview?: string;
  /** Execution duration in ms */
  durationMs?: number;
  /** Whether output was truncated */
  truncated?: boolean;
}

const PREVIEW_LENGTH = 500;

export class AuditLog {
  private logPath: string;

  constructor(logDir: string) {
    this.logPath = join(logDir, 'shell-audit.jsonl');
    const dir = dirname(this.logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Record a command execution */
  record(entry: AuditEntry): void {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(this.logPath, line, 'utf-8');
  }

  /** Record a denied command */
  recordDenied(command: string, role: ShellRole, reason: string): void {
    this.record({
      timestamp: new Date().toISOString(),
      command,
      role,
      allowed: false,
      denyReason: reason,
    });
  }

  /** Record a successful execution */
  recordExecution(
    command: string,
    role: ShellRole,
    exitCode: number,
    stdout: string,
    stderr: string,
    durationMs: number,
  ): void {
    this.record({
      timestamp: new Date().toISOString(),
      command,
      role,
      allowed: true,
      exitCode,
      stdoutPreview: stdout.slice(0, PREVIEW_LENGTH),
      stderrPreview: stderr.slice(0, PREVIEW_LENGTH),
      durationMs,
      truncated: stdout.length > PREVIEW_LENGTH || stderr.length > PREVIEW_LENGTH,
    });
  }

  /** Read the last N audit entries */
  tail(count: number = 20): AuditEntry[] {
    if (!existsSync(this.logPath)) return [];

    const content = readFileSync(this.logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const recent = lines.slice(-count);

    return recent.map(line => {
      try {
        return JSON.parse(line) as AuditEntry;
      } catch {
        return null;
      }
    }).filter((e): e is AuditEntry => e !== null);
  }

  /** Count total entries */
  count(): number {
    if (!existsSync(this.logPath)) return 0;
    const content = readFileSync(this.logPath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).length;
  }

  /** Get stats */
  stats(): { total: number; allowed: number; denied: number; errors: number } {
    const entries = this.tail(10000);
    return {
      total: entries.length,
      allowed: entries.filter(e => e.allowed).length,
      denied: entries.filter(e => !e.allowed).length,
      errors: entries.filter(e => e.allowed && e.exitCode !== 0).length,
    };
  }
}
