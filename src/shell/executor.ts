/**
 * Shell Executor — runs commands via child_process with policy enforcement.
 *
 * Features:
 * - Policy validation before execution
 * - Timeout enforcement
 * - Output size limiting
 * - Audit logging
 * - Working directory sandboxing
 * - Pipeline support (cmd1 | cmd2)
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseCommand, commandToString, flattenPipeline } from './parser.js';
import { validateCommand } from './policy.js';
import type { ShellPolicy, ShellRole } from './policy.js';
import { POLICIES } from './policy.js';
import type { AuditLog } from './audit.js';

export interface ExecutorConfig {
  /** Shell policy to enforce */
  policy: ShellPolicy;
  /** Working directory for commands */
  cwd: string;
  /** Audit log instance */
  audit?: AuditLog;
}

export interface ShellResult {
  /** Whether the command was allowed and executed */
  executed: boolean;
  /** Exit code (0 = success) */
  exitCode: number;
  /** stdout content */
  stdout: string;
  /** stderr content */
  stderr: string;
  /** Execution duration in ms */
  durationMs: number;
  /** The command that was run */
  command: string;
  /** If denied, the reason */
  denyReason?: string;
  /** Whether output was truncated */
  truncated: boolean;
}

export class ShellExecutor {
  private policy: ShellPolicy;
  private cwd: string;
  private audit?: AuditLog;

  constructor(config: ExecutorConfig) {
    this.policy = config.policy;
    this.cwd = resolve(config.cwd);
    this.audit = config.audit;
  }

  /** Get the current policy role */
  get role(): ShellRole {
    return this.policy.role;
  }

  /**
   * Execute a command string.
   * Validates against policy, executes, audits, returns result.
   */
  exec(commandStr: string): ShellResult {
    const parsed = parseCommand(commandStr, { cwd: this.cwd });
    const pipeline = flattenPipeline(parsed.command);

    // Validate each command in the pipeline against policy
    for (const cmd of pipeline) {
      const fullCmd = cmd.env
        ? Object.entries(cmd.env).map(([k, v]) => `${k}=${v}`).join(' ') + ' ' + cmd.binary + ' ' + cmd.args.join(' ')
        : cmd.binary + ' ' + cmd.args.join(' ');
      const check = validateCommand(fullCmd.trim(), this.policy);
      if (!check.allowed) {
        this.audit?.recordDenied(commandStr, this.policy.role, check.reason!);
        return {
          executed: false,
          exitCode: 126, // "Command cannot execute"
          stdout: '',
          stderr: `DENIED: ${check.reason}`,
          durationMs: 0,
          command: commandStr,
          denyReason: check.reason,
          truncated: false,
        };
      }
    }

    // Validate working directory
    const effectiveCwd = parsed.command.cwd || this.cwd;
    if (!this.isAllowedPath(effectiveCwd)) {
      const reason = `Working directory "${effectiveCwd}" not allowed for role "${this.policy.role}"`;
      this.audit?.recordDenied(commandStr, this.policy.role, reason);
      return {
        executed: false,
        exitCode: 126,
        stdout: '',
        stderr: `DENIED: ${reason}`,
        durationMs: 0,
        command: commandStr,
        denyReason: reason,
        truncated: false,
      };
    }

    // Execute
    const timeout = parsed.command.timeout || this.policy.maxTimeout;
    const start = Date.now();

    try {
      // Build the full command string (including pipes)
      const fullCommand = commandToString(parsed.command);

      // Merge environment
      const env = parsed.command.env
        ? { ...process.env, ...parsed.command.env }
        : process.env;

      const output = execSync(fullCommand, {
        cwd: effectiveCwd,
        timeout,
        maxBuffer: this.policy.maxOutputBytes,
        encoding: 'utf-8',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const durationMs = Date.now() - start;
      const stdout = typeof output === 'string' ? output : '';
      const truncated = stdout.length >= this.policy.maxOutputBytes;

      this.audit?.recordExecution(commandStr, this.policy.role, 0, stdout, '', durationMs);

      return {
        executed: true,
        exitCode: 0,
        stdout: truncated ? stdout.slice(0, this.policy.maxOutputBytes) : stdout,
        stderr: '',
        durationMs,
        command: commandStr,
        truncated,
      };
    } catch (e: unknown) {
      const durationMs = Date.now() - start;
      const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
      const exitCode = err.status ?? 1;
      const stdout = (err.stdout as string) ?? '';
      const stderr = (err.stderr as string) ?? err.message ?? String(e);

      this.audit?.recordExecution(commandStr, this.policy.role, exitCode, stdout, stderr, durationMs);

      return {
        executed: true,
        exitCode,
        stdout,
        stderr,
        durationMs,
        command: commandStr,
        truncated: false,
      };
    }
  }

  /** Check if a path is allowed by policy */
  private isAllowedPath(path: string): boolean {
    if (this.policy.allowedPaths.includes('*')) return true;
    if (this.policy.allowedPaths.length === 0) {
      // Default: only cwd and subdirectories
      const resolved = resolve(path);
      return resolved.startsWith(this.cwd);
    }
    // Check against allowed paths
    const resolved = resolve(path);
    return this.policy.allowedPaths.some(allowed => resolved.startsWith(resolve(allowed)));
  }

  /**
   * Dry-run: validate a command without executing.
   */
  validate(commandStr: string): { allowed: boolean; reason?: string; warnings: string[] } {
    const parsed = parseCommand(commandStr, { cwd: this.cwd });
    const pipeline = flattenPipeline(parsed.command);

    for (const cmd of pipeline) {
      const fullCmd = cmd.binary + ' ' + cmd.args.join(' ');
      const check = validateCommand(fullCmd.trim(), this.policy);
      if (!check.allowed) {
        return { allowed: false, reason: check.reason, warnings: parsed.warnings };
      }
    }

    return { allowed: true, warnings: parsed.warnings };
  }
}

/** Create a ShellExecutor with a built-in policy */
export function createExecutor(
  role: ShellRole,
  cwd: string,
  audit?: AuditLog,
): ShellExecutor {
  return new ShellExecutor({
    policy: POLICIES[role],
    cwd,
    audit,
  });
}
