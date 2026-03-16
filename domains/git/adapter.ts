/**
 * Git CLI Domain Adapter — controls Git via terminal commands.
 *
 * Uses the Shell Engine to execute `git` commands with RBAC policy.
 * Discovers available commands from `git help -a` or falls back
 * to built-in definitions for 28 common operations.
 *
 * operationId format: "git.<command>" or "git.<group>.<subcommand>"
 *   e.g. "git.commit", "git.branch.create", "git.stash.pop"
 *
 * The dev RBAC role already allows `git` and blocks dangerous patterns
 * like `git push --force` and `git reset --hard`.
 */

import type { DomainAdapter, PlanNormalizer } from '../../src/domain/adapter.js';
import type {
  Knowledge, ExecutionPlan, ExecutionResult, ExecutionStep,
  ValidationResult, StepResult,
} from '../../src/types/entities.js';
import { ShellExecutor, createExecutor } from '../../src/shell/executor.js';
import { AuditLog } from '../../src/shell/audit.js';
import type { ShellRole } from '../../src/shell/policy.js';
import { join } from 'node:path';

export interface GitAdapterConfig {
  /** Shell RBAC role (default: 'dev') */
  role?: ShellRole;
  /** Working directory — the git repo to operate on */
  cwd?: string;
  /** Audit log directory */
  auditDir?: string;
  /** Custom git binary path (default: 'git') */
  gitBinary?: string;
}

// Commands that are read-only and safe for readonly role
const READONLY_OPS = new Set([
  'git.status', 'git.log', 'git.diff', 'git.show',
  'git.branch.list', 'git.tag.list', 'git.remote.list',
  'git.blame', 'git.shortlog',
]);

// Destructive commands that warrant a warning
const DESTRUCTIVE_OPS = new Set([
  'git.reset', 'git.rebase', 'git.clean',
  'git.branch.delete', 'git.push.force',
]);

/**
 * Maps an operationId to the git command parts + how to build params.
 * For each operation: [baseCommand, ...paramHandlers]
 */
interface CmdSpec {
  /** Base git subcommand (e.g. "commit", "branch") */
  cmd: string;
  /** Fixed flags to always include */
  fixedFlags?: string[];
  /** How to map params to command arguments */
  paramMap?: Record<string, ParamHandler>;
  /** Keys that are positional args (in order) */
  positional?: string[];
}

type ParamHandler = 'flag' | 'short-flag' | 'value' | 'positional';

const CMD_SPECS: Record<string, CmdSpec> = {
  'git.init':            { cmd: 'init', positional: ['directory'] },
  'git.clone':           { cmd: 'clone', positional: ['url', 'directory'] },
  'git.add':             { cmd: 'add', positional: ['files'] },
  'git.commit':          { cmd: 'commit', paramMap: { message: 'short-flag', all: 'flag', amend: 'flag', 'no-edit': 'flag' } },
  'git.status':          { cmd: 'status', paramMap: { short: 'flag', branch: 'flag', porcelain: 'flag' } },
  'git.push':            { cmd: 'push', positional: ['remote', 'branch'], paramMap: { tags: 'flag', 'set-upstream': 'flag', u: 'flag' } },
  'git.pull':            { cmd: 'pull', positional: ['remote', 'branch'], paramMap: { rebase: 'flag', ff_only: 'flag' } },
  'git.fetch':           { cmd: 'fetch', positional: ['remote'], paramMap: { all: 'flag', prune: 'flag', tags: 'flag' } },
  'git.log':             { cmd: 'log', paramMap: { oneline: 'flag', n: 'short-flag', graph: 'flag', all: 'flag', format: 'value' } },
  'git.diff':            { cmd: 'diff', positional: ['target'], paramMap: { staged: 'flag', cached: 'flag', stat: 'flag', name_only: 'flag' } },
  'git.show':            { cmd: 'show', positional: ['ref'], paramMap: { stat: 'flag', format: 'value' } },
  'git.blame':           { cmd: 'blame', positional: ['file'], paramMap: { L: 'short-flag' } },
  'git.shortlog':        { cmd: 'shortlog', paramMap: { s: 'flag', n: 'flag', e: 'flag' } },
  'git.checkout':        { cmd: 'checkout', positional: ['target'], paramMap: { b: 'short-flag' } },
  'git.switch':          { cmd: 'switch', positional: ['branch'], paramMap: { create: 'flag', c: 'short-flag' } },
  'git.branch.create':   { cmd: 'branch', positional: ['name', 'start_point'] },
  'git.branch.list':     { cmd: 'branch', paramMap: { all: 'flag', remote: 'flag', verbose: 'flag' } },
  'git.branch.delete':   { cmd: 'branch', fixedFlags: ['-d'], positional: ['name'] },
  'git.merge':           { cmd: 'merge', positional: ['branch'], paramMap: { 'no-ff': 'flag', squash: 'flag', message: 'short-flag' } },
  'git.rebase':          { cmd: 'rebase', positional: ['upstream', 'branch'], paramMap: { interactive: 'flag', abort: 'flag', continue: 'flag' } },
  'git.cherry-pick':     { cmd: 'cherry-pick', positional: ['commit'], paramMap: { 'no-commit': 'flag' } },
  'git.reset':           { cmd: 'reset', positional: ['target'], paramMap: { hard: 'flag', soft: 'flag', mixed: 'flag' } },
  'git.revert':          { cmd: 'revert', positional: ['commit'], paramMap: { 'no-commit': 'flag', 'no-edit': 'flag' } },
  'git.clean':           { cmd: 'clean', paramMap: { force: 'flag', d: 'flag', n: 'flag' } },
  'git.stash':           { cmd: 'stash', paramMap: { message: 'short-flag' } },
  'git.stash.pop':       { cmd: 'stash pop', positional: ['stash'] },
  'git.stash.list':      { cmd: 'stash list' },
  'git.stash.drop':      { cmd: 'stash drop', positional: ['stash'] },
  'git.tag.create':      { cmd: 'tag', positional: ['name', 'commit'], paramMap: { a: 'flag', message: 'short-flag' } },
  'git.tag.list':        { cmd: 'tag', fixedFlags: ['-l'], positional: ['pattern'] },
  'git.tag.delete':      { cmd: 'tag', fixedFlags: ['-d'], positional: ['name'] },
  'git.remote.add':      { cmd: 'remote add', positional: ['name', 'url'] },
  'git.remote.list':     { cmd: 'remote', fixedFlags: ['-v'] },
  'git.remote.remove':   { cmd: 'remote remove', positional: ['name'] },
};

export class GitAdapter implements DomainAdapter {
  readonly id = 'git';
  readonly name = 'Git (CLI)';
  private config: GitAdapterConfig;
  private executor: ShellExecutor;

  constructor(config?: GitAdapterConfig) {
    this.config = config ?? {};
    const auditDir = config?.auditDir || join(process.cwd(), '.ctt-shell', 'logs');
    const audit = new AuditLog(auditDir);
    this.executor = createExecutor(config?.role ?? 'dev', config?.cwd ?? process.cwd(), audit);
  }

  // ─── Knowledge Extraction ──────────────────────────────────────────────────

  async extractKnowledge(): Promise<Knowledge[]> {
    return GIT_KNOWLEDGE;
  }

  // ─── Execution ─────────────────────────────────────────────────────────────

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    const start = Date.now();
    const outputs = new Map<string, unknown>();
    const stepResults: StepResult[] = [];

    for (const step of plan.steps) {
      const stepStart = Date.now();

      try {
        const cmd = this.buildCommand(step, outputs);

        const result = this.executor.exec(cmd);

        if (!result.executed) {
          stepResults.push({
            stepId: step.stepId,
            operationId: step.operationId,
            success: false,
            error: `Denied: ${result.denyReason}`,
            durationMs: Date.now() - stepStart,
          });
          continue;
        }

        if (result.exitCode !== 0) {
          stepResults.push({
            stepId: step.stepId,
            operationId: step.operationId,
            success: false,
            error: result.stderr || `Exit code: ${result.exitCode}`,
            response: result.stdout,
            durationMs: Date.now() - stepStart,
          });
          continue;
        }

        // Parse output
        const response = this.parseOutput(result.stdout, step);
        if (step.outputRef) {
          outputs.set(step.outputRef, response);
        }

        stepResults.push({
          stepId: step.stepId,
          operationId: step.operationId,
          success: true,
          response,
          durationMs: Date.now() - stepStart,
        });
      } catch (e) {
        stepResults.push({
          stepId: step.stepId,
          operationId: step.operationId,
          success: false,
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - stepStart,
        });
      }
    }

    const success = stepResults.every(s => s.success);
    return {
      success,
      goal: plan.goal,
      domainId: 'git',
      steps: stepResults,
      totalDurationMs: Date.now() - start,
      error: success ? undefined : stepResults.find(s => !s.success)?.error,
    };
  }

  /** Build a git command string from an execution step */
  private buildCommand(step: ExecutionStep, outputs: Map<string, unknown>): string {
    const git = this.config.gitBinary || 'git';
    const spec = CMD_SPECS[step.operationId];

    if (!spec) {
      // Fallback: try to convert operationId to command
      // git.some.thing → git some thing
      const subcommand = step.operationId.replace(/^git\./, '').replace(/\./g, ' ');
      const parts = [git, subcommand];
      const resolved = this.resolveRefs(step.params, outputs);
      for (const [key, value] of Object.entries(resolved)) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'boolean' && value) {
          parts.push(key.length === 1 ? `-${key}` : `--${key}`);
        } else if (key === '_positional') {
          parts.push(this.shellEscape(String(value)));
        } else {
          parts.push(key.length === 1 ? `-${key}` : `--${key}`);
          parts.push(this.shellEscape(String(value)));
        }
      }
      return parts.join(' ');
    }

    const parts = [git, spec.cmd];

    // Add fixed flags
    if (spec.fixedFlags) {
      parts.push(...spec.fixedFlags);
    }

    // Resolve refs in params
    const resolved = this.resolveRefs(step.params, outputs);

    // Process paramMap flags first
    if (spec.paramMap) {
      for (const [key, handler] of Object.entries(spec.paramMap)) {
        const paramKey = key.replace(/_/g, '-'); // ff_only → ff-only
        const value = resolved[key] ?? resolved[paramKey];
        if (value === undefined || value === null) continue;

        switch (handler) {
          case 'flag':
            if (value === true || value === 'true') {
              parts.push(key.length === 1 ? `-${key}` : `--${paramKey}`);
            }
            break;
          case 'short-flag':
            // -m "message" style
            parts.push(`-${key.length === 1 ? key : key[0]}`);
            parts.push(this.shellEscape(String(value)));
            break;
          case 'value':
            parts.push(`--${paramKey}=${this.shellEscape(String(value))}`);
            break;
        }
      }
    }

    // Process positional args
    if (spec.positional) {
      for (const posKey of spec.positional) {
        const value = resolved[posKey] ?? resolved['_positional'];
        if (value !== undefined && value !== null) {
          // Files can be space-separated list
          if (posKey === 'files') {
            const files = String(value).split(/\s+/);
            for (const f of files) {
              parts.push(this.shellEscape(f));
            }
          } else {
            parts.push(this.shellEscape(String(value)));
          }
          // Only use _positional once
          if (resolved['_positional'] !== undefined) {
            delete resolved['_positional'];
          }
        }
      }
    }

    // Add any remaining unknown params as flags
    const knownKeys = new Set([
      ...(spec.positional || []),
      ...Object.keys(spec.paramMap || {}),
      '_positional',
    ]);
    for (const [key, value] of Object.entries(resolved)) {
      if (knownKeys.has(key) || knownKeys.has(key.replace(/-/g, '_'))) continue;
      if (value === undefined || value === null) continue;
      if (typeof value === 'boolean' && value) {
        parts.push(key.length === 1 ? `-${key}` : `--${key}`);
      } else if (typeof value === 'string') {
        parts.push(key.length === 1 ? `-${key}` : `--${key}`);
        parts.push(this.shellEscape(value));
      }
    }

    return parts.join(' ');
  }

  /** Parse git output into structured data */
  private parseOutput(stdout: string, step: ExecutionStep): unknown {
    const trimmed = stdout.trim();

    // Porcelain/short status → parse into entries
    if (step.operationId === 'git.status' && step.params.porcelain) {
      const files = trimmed.split('\n').filter(Boolean).map(line => ({
        status: line.slice(0, 2).trim(),
        file: line.slice(3),
      }));
      return { files };
    }

    // Branch list → parse into names
    if (step.operationId === 'git.branch.list') {
      const branches = trimmed.split('\n').filter(Boolean).map(line => {
        const current = line.startsWith('*');
        const name = line.replace(/^\*?\s+/, '').trim();
        return { name, current };
      });
      return { branches };
    }

    // Tag list → parse into names
    if (step.operationId === 'git.tag.list') {
      const tags = trimmed.split('\n').filter(Boolean).map(t => t.trim());
      return { tags };
    }

    // Remote list → parse into entries
    if (step.operationId === 'git.remote.list') {
      const remotes: Array<{ name: string; url: string; type: string }> = [];
      for (const line of trimmed.split('\n').filter(Boolean)) {
        const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
        if (match) {
          remotes.push({ name: match[1], url: match[2], type: match[3] });
        }
      }
      return { remotes };
    }

    // Stash list → parse entries
    if (step.operationId === 'git.stash.list') {
      const stashes = trimmed.split('\n').filter(Boolean).map(line => {
        const match = line.match(/^(stash@\{\d+\}):\s+(.+)$/);
        return match ? { ref: match[1], description: match[2] } : { ref: line, description: '' };
      });
      return { stashes };
    }

    // Default: return as text
    return { output: trimmed };
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  validate(plan: ExecutionPlan): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const knownOps = new Set(GIT_KNOWLEDGE.map(k => k.operationId));

    for (const step of plan.steps) {
      if (!step.operationId.startsWith('git.')) {
        errors.push(`Step ${step.stepId}: operationId "${step.operationId}" must start with "git."`);
        continue;
      }

      if (!knownOps.has(step.operationId)) {
        warnings.push(`Step ${step.stepId}: unknown operation "${step.operationId}" (may work if git supports it)`);
      }

      if (DESTRUCTIVE_OPS.has(step.operationId)) {
        warnings.push(`Step ${step.stepId}: "${step.operationId}" is a destructive operation`);
      }

      // Check deps
      if (step.dependsOn) {
        const validIds = new Set(plan.steps.map(s => s.stepId));
        for (const dep of step.dependsOn) {
          if (!validIds.has(dep)) {
            errors.push(`Step ${step.stepId} depends on non-existent step ${dep}`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ─── Query Expansions ──────────────────────────────────────────────────────

  queryExpansions(): Record<string, string[]> {
    return {
      'commit': ['save', 'snapshot', 'record', 'check-in'],
      'branch': ['fork', 'diverge', 'feature', 'topic'],
      'merge': ['combine', 'join', 'integrate', 'unify'],
      'push': ['upload', 'deploy', 'publish', 'send'],
      'pull': ['download', 'sync', 'update', 'fetch'],
      'stash': ['save', 'shelve', 'park', 'set-aside'],
      'diff': ['compare', 'changes', 'delta', 'difference'],
      'log': ['history', 'commits', 'timeline', 'changelog'],
      'clone': ['copy', 'download', 'fork', 'duplicate'],
      'checkout': ['switch', 'change', 'move', 'go-to'],
      'tag': ['release', 'version', 'label', 'mark'],
      'rebase': ['replay', 'reorder', 'rewrite', 'linearize'],
      'reset': ['undo', 'rollback', 'unstage', 'discard'],
      'revert': ['undo', 'reverse', 'back-out'],
      'blame': ['annotate', 'who', 'author', 'attribute'],
      'remote': ['origin', 'upstream', 'server', 'repository'],
      'status': ['state', 'working-tree', 'modified', 'staged'],
    };
  }

  // ─── Plan Normalizers ──────────────────────────────────────────────────────

  planNormalizers(): PlanNormalizer[] {
    return [
      // Fix shorthand operationIds: "commit" → "git.commit", "git commit" → "git.commit"
      (plan, fixes) => {
        for (const step of plan.steps) {
          if (!step.operationId.startsWith('git.')) {
            const cleaned = step.operationId.replace(/\s+/g, '.').replace(/-/g, '.');
            step.operationId = `git.${cleaned}`;
            fixes.push(`added git. prefix to operationId`);
          }
        }
      },
      // Fix spaces and hyphens in operationId: "git branch create" → "git.branch.create"
      (plan, fixes) => {
        for (const step of plan.steps) {
          if (step.operationId.includes(' ')) {
            step.operationId = step.operationId.replace(/\s+/g, '.');
            fixes.push(`replaced spaces with dots in operationId`);
          }
        }
      },
      // Rename common param mistakes
      (plan, fixes) => {
        for (const step of plan.steps) {
          const p = step.params;

          // "msg" or "message" → "message" for git.commit (used as -m flag)
          if (step.operationId === 'git.commit') {
            if (p['msg'] && !p['message']) {
              p['message'] = p['msg'];
              delete p['msg'];
              fixes.push('renamed msg→message for commit');
            }
            if (p['m'] && !p['message']) {
              p['message'] = p['m'];
              delete p['m'];
              fixes.push('renamed m→message for commit');
            }
          }

          // "branch" or "branch_name" → positional "name" for branch.create
          if (step.operationId === 'git.branch.create') {
            if ((p['branch'] || p['branch_name']) && !p['name']) {
              p['name'] = p['branch'] || p['branch_name'];
              delete p['branch'];
              delete p['branch_name'];
              fixes.push('moved branch/branch_name to name for branch.create');
            }
          }

          // "repo" or "repository" → "url" for git.clone
          if (step.operationId === 'git.clone') {
            if ((p['repo'] || p['repository']) && !p['url']) {
              p['url'] = p['repo'] || p['repository'];
              delete p['repo'];
              delete p['repository'];
              fixes.push('renamed repo/repository→url for clone');
            }
          }

          // "ref" or "commit" → "target" for git.checkout
          if (step.operationId === 'git.checkout') {
            if ((p['branch'] || p['ref']) && !p['target']) {
              p['target'] = p['branch'] || p['ref'];
              delete p['branch'];
              delete p['ref'];
              fixes.push('moved branch/ref to target for checkout');
            }
          }

          // "path" or "file" → "files" for git.add
          if (step.operationId === 'git.add') {
            if (p['file'] && !p['files']) {
              p['files'] = p['file'];
              delete p['file'];
              fixes.push('renamed file→files for git.add');
            }
            if (p['path'] && !p['files']) {
              p['files'] = p['path'];
              delete p['path'];
              fixes.push('renamed path→files for git.add');
            }
            // "all" flag → files = "."
            if (p['all'] === true && !p['files']) {
              p['files'] = '.';
              delete p['all'];
              fixes.push('converted all→"." for git.add');
            }
          }
        }
      },
    ];
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private shellEscape(value: string): string {
    if (/^[a-zA-Z0-9._\-/:@~^{}]+$/.test(value)) return value;
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private resolveRefs(params: Record<string, unknown>, outputs: Map<string, unknown>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.includes('{{')) {
        resolved[key] = value.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_match, ref, field) => {
          const output = outputs.get(ref as string) as Record<string, unknown> | undefined;
          return output?.[field as string] !== undefined ? String(output[field as string]) : value;
        });
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}

// ─── Built-in Knowledge (28 common Git operations) ───────────────────────────

function k(
  id: string, opId: string, display: string, desc: string, cat: string,
  params: Array<{ name: string; type: string; description: string; required: boolean }>,
  tags: string[] = [],
): Knowledge {
  return {
    id: `git-${id}`, type: 'knowledge', domainId: 'git',
    createdAt: '', updatedAt: '', tags: ['git', cat, ...tags],
    operationId: opId, displayName: display, description: desc,
    category: cat, parameters: params,
  };
}

const GIT_KNOWLEDGE: Knowledge[] = [
  // ── Repository Setup ──
  k('init', 'git.init', 'git init', 'Initialize a new Git repository', 'setup', [
    { name: 'directory', type: 'string', description: 'Directory to initialize (default: current)', required: false },
  ], ['create']),
  k('clone', 'git.clone', 'git clone', 'Clone a remote repository', 'setup', [
    { name: 'url', type: 'string', description: 'Repository URL to clone', required: true },
    { name: 'directory', type: 'string', description: 'Target directory name', required: false },
  ], ['copy', 'download']),

  // ── Staging & Committing ──
  k('add', 'git.add', 'git add', 'Stage files for commit', 'staging', [
    { name: 'files', type: 'string', description: 'Files to stage (space-separated, or "." for all)', required: true },
  ], ['stage']),
  k('commit', 'git.commit', 'git commit', 'Create a commit with staged changes', 'staging', [
    { name: 'message', type: 'string', description: 'Commit message', required: true },
    { name: 'all', type: 'boolean', description: 'Automatically stage modified files (-a)', required: false },
    { name: 'amend', type: 'boolean', description: 'Amend the last commit', required: false },
  ], ['save', 'snapshot']),
  k('status', 'git.status', 'git status', 'Show the working tree status', 'info', [
    { name: 'short', type: 'boolean', description: 'Show short format', required: false },
    { name: 'porcelain', type: 'boolean', description: 'Machine-readable output', required: false },
  ], ['state', 'modified']),

  // ── Branches ──
  k('branch-create', 'git.branch.create', 'git branch (create)', 'Create a new branch', 'branch', [
    { name: 'name', type: 'string', description: 'New branch name', required: true },
    { name: 'start_point', type: 'string', description: 'Starting commit/branch (default: HEAD)', required: false },
  ], ['create', 'fork']),
  k('branch-list', 'git.branch.list', 'git branch (list)', 'List branches', 'branch', [
    { name: 'all', type: 'boolean', description: 'List all branches (local + remote)', required: false },
    { name: 'remote', type: 'boolean', description: 'List remote branches only', required: false },
  ], ['list']),
  k('branch-delete', 'git.branch.delete', 'git branch -d (delete)', 'Delete a branch', 'branch', [
    { name: 'name', type: 'string', description: 'Branch name to delete', required: true },
  ], ['delete', 'remove']),
  k('checkout', 'git.checkout', 'git checkout', 'Switch branches or restore files', 'branch', [
    { name: 'target', type: 'string', description: 'Branch name, tag, or commit to check out', required: true },
    { name: 'b', type: 'string', description: 'Create and switch to a new branch', required: false },
  ], ['switch', 'change']),
  k('switch', 'git.switch', 'git switch', 'Switch branches (modern alternative to checkout)', 'branch', [
    { name: 'branch', type: 'string', description: 'Branch to switch to', required: true },
    { name: 'create', type: 'boolean', description: 'Create the branch if it doesn\'t exist', required: false },
  ], ['change']),

  // ── Remote ──
  k('push', 'git.push', 'git push', 'Push commits to a remote repository', 'remote', [
    { name: 'remote', type: 'string', description: 'Remote name (default: origin)', required: false },
    { name: 'branch', type: 'string', description: 'Branch to push', required: false },
    { name: 'tags', type: 'boolean', description: 'Push all tags', required: false },
    { name: 'u', type: 'boolean', description: 'Set upstream tracking (-u)', required: false },
  ], ['upload', 'publish']),
  k('pull', 'git.pull', 'git pull', 'Fetch and merge from a remote repository', 'remote', [
    { name: 'remote', type: 'string', description: 'Remote name (default: origin)', required: false },
    { name: 'branch', type: 'string', description: 'Branch to pull', required: false },
    { name: 'rebase', type: 'boolean', description: 'Rebase instead of merge', required: false },
  ], ['download', 'sync']),
  k('fetch', 'git.fetch', 'git fetch', 'Download objects and refs from a remote', 'remote', [
    { name: 'remote', type: 'string', description: 'Remote name (default: origin)', required: false },
    { name: 'all', type: 'boolean', description: 'Fetch from all remotes', required: false },
    { name: 'prune', type: 'boolean', description: 'Remove deleted remote branches', required: false },
  ], ['download']),
  k('remote-add', 'git.remote.add', 'git remote add', 'Add a new remote', 'remote', [
    { name: 'name', type: 'string', description: 'Remote name (e.g., origin)', required: true },
    { name: 'url', type: 'string', description: 'Remote URL', required: true },
  ], ['add']),
  k('remote-list', 'git.remote.list', 'git remote -v', 'List configured remotes', 'remote', [], ['list']),
  k('remote-remove', 'git.remote.remove', 'git remote remove', 'Remove a remote', 'remote', [
    { name: 'name', type: 'string', description: 'Remote name to remove', required: true },
  ], ['delete']),

  // ── History ──
  k('log', 'git.log', 'git log', 'Show commit history', 'history', [
    { name: 'n', type: 'number', description: 'Number of commits to show', required: false },
    { name: 'oneline', type: 'boolean', description: 'One line per commit', required: false },
    { name: 'graph', type: 'boolean', description: 'Show ASCII graph', required: false },
    { name: 'all', type: 'boolean', description: 'Show all branches', required: false },
    { name: 'format', type: 'string', description: 'Pretty format string', required: false },
  ], ['history', 'commits']),
  k('diff', 'git.diff', 'git diff', 'Show changes between commits, working tree, etc.', 'history', [
    { name: 'target', type: 'string', description: 'Commit, branch, or range to diff against', required: false },
    { name: 'staged', type: 'boolean', description: 'Show staged changes (--staged)', required: false },
    { name: 'stat', type: 'boolean', description: 'Show diffstat summary', required: false },
    { name: 'name_only', type: 'boolean', description: 'Show only file names', required: false },
  ], ['compare', 'changes']),
  k('show', 'git.show', 'git show', 'Show a commit, tag, or other object', 'history', [
    { name: 'ref', type: 'string', description: 'Commit hash, tag, or ref to show', required: false },
    { name: 'stat', type: 'boolean', description: 'Show diffstat only', required: false },
  ], ['inspect', 'detail']),
  k('blame', 'git.blame', 'git blame', 'Show line-by-line authorship of a file', 'history', [
    { name: 'file', type: 'string', description: 'File to annotate', required: true },
    { name: 'L', type: 'string', description: 'Line range (e.g., "10,20")', required: false },
  ], ['annotate', 'who']),

  // ── Merging ──
  k('merge', 'git.merge', 'git merge', 'Merge a branch into the current branch', 'merge', [
    { name: 'branch', type: 'string', description: 'Branch to merge', required: true },
    { name: 'no-ff', type: 'boolean', description: 'Create a merge commit even for fast-forward', required: false },
    { name: 'squash', type: 'boolean', description: 'Squash all commits into one', required: false },
    { name: 'message', type: 'string', description: 'Merge commit message', required: false },
  ], ['combine', 'integrate']),
  k('rebase', 'git.rebase', 'git rebase', 'Reapply commits on top of another base', 'merge', [
    { name: 'upstream', type: 'string', description: 'Upstream branch to rebase onto', required: true },
    { name: 'abort', type: 'boolean', description: 'Abort an in-progress rebase', required: false },
    { name: 'continue', type: 'boolean', description: 'Continue after resolving conflicts', required: false },
  ], ['replay']),
  k('cherry-pick', 'git.cherry-pick', 'git cherry-pick', 'Apply a specific commit to the current branch', 'merge', [
    { name: 'commit', type: 'string', description: 'Commit hash to cherry-pick', required: true },
    { name: 'no-commit', type: 'boolean', description: 'Apply changes without committing', required: false },
  ], ['pick', 'apply']),

  // ── Stash ──
  k('stash', 'git.stash', 'git stash', 'Stash current changes', 'stash', [
    { name: 'message', type: 'string', description: 'Stash description message', required: false },
  ], ['save', 'shelve']),
  k('stash-pop', 'git.stash.pop', 'git stash pop', 'Apply and remove the latest stash', 'stash', [
    { name: 'stash', type: 'string', description: 'Stash reference (default: stash@{0})', required: false },
  ], ['restore', 'apply']),
  k('stash-list', 'git.stash.list', 'git stash list', 'List all stashes', 'stash', [], ['list']),

  // ── Tags ──
  k('tag-create', 'git.tag.create', 'git tag', 'Create a tag', 'tag', [
    { name: 'name', type: 'string', description: 'Tag name (e.g., v1.0.0)', required: true },
    { name: 'commit', type: 'string', description: 'Commit to tag (default: HEAD)', required: false },
    { name: 'a', type: 'boolean', description: 'Create an annotated tag', required: false },
    { name: 'message', type: 'string', description: 'Tag message (for annotated tags)', required: false },
  ], ['create', 'release', 'version']),
  k('tag-list', 'git.tag.list', 'git tag -l', 'List tags', 'tag', [
    { name: 'pattern', type: 'string', description: 'Pattern to filter tags (e.g., "v1.*")', required: false },
  ], ['list']),

  // ── Undo ──
  k('reset', 'git.reset', 'git reset', 'Reset HEAD to a specified state', 'undo', [
    { name: 'target', type: 'string', description: 'Commit or ref to reset to', required: false },
    { name: 'hard', type: 'boolean', description: 'Discard all changes (DESTRUCTIVE)', required: false },
    { name: 'soft', type: 'boolean', description: 'Keep changes staged', required: false },
    { name: 'mixed', type: 'boolean', description: 'Keep changes unstaged (default)', required: false },
  ], ['undo', 'rollback']),
  k('revert', 'git.revert', 'git revert', 'Create a new commit that reverses a previous commit', 'undo', [
    { name: 'commit', type: 'string', description: 'Commit to revert', required: true },
    { name: 'no-commit', type: 'boolean', description: 'Apply revert without committing', required: false },
    { name: 'no-edit', type: 'boolean', description: 'Use default revert message', required: false },
  ], ['reverse', 'undo']),
];

// ─── Eval Goals ──────────────────────────────────────────────────────────────

export const GIT_EVAL_GOALS = [
  {
    goal: 'Show the current git status',
    domainId: 'git',
    expectedOps: ['git.status'],
    complexity: 'simple' as const,
  },
  {
    goal: 'List all branches including remote',
    domainId: 'git',
    expectedOps: ['git.branch.list'],
    complexity: 'simple' as const,
  },
  {
    goal: 'Stage all files and commit with message "initial commit"',
    domainId: 'git',
    expectedOps: ['git.add', 'git.commit'],
    complexity: 'medium' as const,
  },
  {
    goal: 'Create a new branch called feature-login, switch to it, then show the commit log',
    domainId: 'git',
    expectedOps: ['git.branch.create', 'git.checkout', 'git.log'],
    complexity: 'medium' as const,
  },
  {
    goal: 'Create an annotated tag v1.0.0, push all tags to origin, then list all tags',
    domainId: 'git',
    expectedOps: ['git.tag.create', 'git.push', 'git.tag.list'],
    complexity: 'complex' as const,
  },
];
