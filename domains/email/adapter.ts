/**
 * Email Domain Adapter — controls email via Himalaya CLI.
 *
 * Uses the Shell Engine to execute `himalaya` commands with RBAC policy.
 * Himalaya is a cross-platform CLI email client with JSON output,
 * supporting IMAP (read/search/manage) and SMTP (send).
 *
 * operationId format: "email.<resource>.<action>"
 *   e.g. "email.message.read", "email.folder.list", "email.flag.add"
 *
 * Requires himalaya installed and configured (~/.config/himalaya/config.toml).
 * Supports IMAP/SMTP with OAuth2 and App Passwords (Gmail, Outlook, etc.).
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

export interface EmailAdapterConfig {
  /** Shell RBAC role (default: 'dev') */
  role?: ShellRole;
  /** Working directory */
  cwd?: string;
  /** Audit log directory */
  auditDir?: string;
  /** Custom himalaya binary path (default: 'himalaya') */
  binary?: string;
  /** Account name to use (default: himalaya default account) */
  account?: string;
}

// Read-only operations safe for readonly role
const READONLY_OPS = new Set([
  'email.envelope.list', 'email.envelope.search',
  'email.message.read', 'email.folder.list',
  'email.attachment.list',
]);

// Destructive operations that warrant a warning
const DESTRUCTIVE_OPS = new Set([
  'email.message.delete', 'email.folder.delete',
  'email.folder.purge',
]);

/**
 * Maps an operationId to the himalaya subcommand + param handling.
 */
interface CmdSpec {
  /** Himalaya subcommand (e.g. "envelope list", "message read") */
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
  // ── Folders ──
  'email.folder.list':     { cmd: 'folder list', fixedFlags: ['--output', 'json'] },
  'email.folder.create':   { cmd: 'folder create', positional: ['name'] },
  'email.folder.delete':   { cmd: 'folder delete', positional: ['name'] },

  // ── Envelopes (list/search) ──
  'email.envelope.list':   {
    cmd: 'envelope list',
    fixedFlags: ['--output', 'json'],
    paramMap: { folder: 'value', page: 'value', 'page-size': 'value' },
    positional: ['query'],
  },
  'email.envelope.search': {
    cmd: 'envelope list',
    fixedFlags: ['--output', 'json'],
    paramMap: { folder: 'value', page: 'value', 'page-size': 'value' },
    positional: ['query'],
  },

  // ── Messages ──
  'email.message.read':    {
    cmd: 'message read',
    fixedFlags: ['--output', 'json'],
    paramMap: { folder: 'value', 'html': 'flag', 'raw': 'flag' },
    positional: ['id'],
  },
  'email.message.write':   {
    cmd: 'message write',
    paramMap: { from: 'value', to: 'value', subject: 'value', body: 'value', cc: 'value', bcc: 'value', attachment: 'value' },
  },
  'email.message.send':    {
    cmd: 'message send',
    paramMap: { from: 'value', to: 'value', subject: 'value', body: 'value', cc: 'value', bcc: 'value', attachment: 'value' },
  },
  'email.message.reply':   {
    cmd: 'message reply',
    paramMap: { folder: 'value', all: 'flag', body: 'value' },
    positional: ['id'],
  },
  'email.message.forward': {
    cmd: 'message forward',
    paramMap: { folder: 'value', to: 'value' },
    positional: ['id'],
  },
  'email.message.copy':    {
    cmd: 'message copy',
    paramMap: { folder: 'value' },
    positional: ['id', 'target'],
  },
  'email.message.move':    {
    cmd: 'message move',
    paramMap: { folder: 'value' },
    positional: ['id', 'target'],
  },
  'email.message.delete':  {
    cmd: 'message delete',
    paramMap: { folder: 'value' },
    positional: ['id'],
  },

  // ── Flags ──
  'email.flag.add':        {
    cmd: 'flag add',
    paramMap: { folder: 'value' },
    positional: ['id', 'flags'],
  },
  'email.flag.remove':     {
    cmd: 'flag remove',
    paramMap: { folder: 'value' },
    positional: ['id', 'flags'],
  },

  // ── Attachments ──
  'email.attachment.download': {
    cmd: 'attachment download',
    paramMap: { folder: 'value' },
    positional: ['id'],
  },
};

export class EmailAdapter implements DomainAdapter {
  readonly id = 'email';
  readonly name = 'Email (Himalaya CLI)';
  private config: EmailAdapterConfig;
  private executor: ShellExecutor;

  constructor(config?: EmailAdapterConfig) {
    this.config = config ?? {};
    const auditDir = config?.auditDir || join(process.cwd(), '.ctt-shell', 'logs');
    const audit = new AuditLog(auditDir);
    this.executor = createExecutor(config?.role ?? 'dev', config?.cwd ?? process.cwd(), audit);
  }

  // ─── Knowledge Extraction ──────────────────────────────────────────────────

  async extractKnowledge(): Promise<Knowledge[]> {
    return EMAIL_KNOWLEDGE;
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
      domainId: 'email',
      steps: stepResults,
      totalDurationMs: Date.now() - start,
      error: success ? undefined : stepResults.find(s => !s.success)?.error,
    };
  }

  /** Build a himalaya command string from an execution step */
  private buildCommand(step: ExecutionStep, outputs: Map<string, unknown>): string {
    const bin = this.config.binary || 'himalaya';
    const spec = CMD_SPECS[step.operationId];

    // Account flag
    const accountFlag = this.config.account ? ` --account ${this.shellEscape(this.config.account)}` : '';

    if (!spec) {
      // Fallback: convert operationId to subcommand
      // email.some.thing → himalaya some thing
      const subcommand = step.operationId.replace(/^email\./, '').replace(/\./g, ' ');
      const parts = [bin + accountFlag, subcommand];
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

    const parts = [bin + accountFlag, spec.cmd];

    // Add fixed flags
    if (spec.fixedFlags) {
      parts.push(...spec.fixedFlags);
    }

    // Resolve refs in params
    const resolved = this.resolveRefs(step.params, outputs);

    // Process paramMap flags first
    if (spec.paramMap) {
      for (const [key, handler] of Object.entries(spec.paramMap)) {
        const paramKey = key.replace(/_/g, '-');
        const value = resolved[key] ?? resolved[paramKey];
        if (value === undefined || value === null) continue;

        switch (handler) {
          case 'flag':
            if (value === true || value === 'true') {
              parts.push(key.length === 1 ? `-${key}` : `--${paramKey}`);
            }
            break;
          case 'short-flag':
            parts.push(`-${key.length === 1 ? key : key[0]}`);
            parts.push(this.shellEscape(String(value)));
            break;
          case 'value':
            parts.push(`--${paramKey}`);
            parts.push(this.shellEscape(String(value)));
            break;
        }
      }
    }

    // Process positional args
    if (spec.positional) {
      for (const posKey of spec.positional) {
        const value = resolved[posKey] ?? resolved['_positional'];
        if (value !== undefined && value !== null) {
          // Flags can be space-separated
          if (posKey === 'flags') {
            const flags = String(value).split(/\s+/);
            for (const f of flags) {
              parts.push(this.shellEscape(f));
            }
          } else {
            parts.push(this.shellEscape(String(value)));
          }
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

  /** Parse himalaya output into structured data */
  private parseOutput(stdout: string, step: ExecutionStep): unknown {
    const trimmed = stdout.trim();

    // Most himalaya commands with --output json return valid JSON
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return JSON.parse(trimmed);
      } catch { /* fall through to text */ }
    }

    // Folder list → parse lines if not JSON
    if (step.operationId === 'email.folder.list') {
      const folders = trimmed.split('\n').filter(Boolean).map(line => line.trim());
      return { folders };
    }

    // Default: return as text
    return { output: trimmed };
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  validate(plan: ExecutionPlan): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const knownOps = new Set(EMAIL_KNOWLEDGE.map(k => k.operationId));

    for (const step of plan.steps) {
      if (!step.operationId.startsWith('email.')) {
        errors.push(`Step ${step.stepId}: operationId "${step.operationId}" must start with "email."`);
        continue;
      }

      if (!knownOps.has(step.operationId)) {
        warnings.push(`Step ${step.stepId}: unknown operation "${step.operationId}" (may work if himalaya supports it)`);
      }

      if (DESTRUCTIVE_OPS.has(step.operationId)) {
        warnings.push(`Step ${step.stepId}: "${step.operationId}" is a destructive operation`);
      }

      // Validate required params for key operations
      if (step.operationId === 'email.message.read' && !step.params.id) {
        errors.push(`Step ${step.stepId}: email.message.read requires "id" parameter`);
      }

      if (step.operationId === 'email.message.send') {
        if (!step.params.to) errors.push(`Step ${step.stepId}: email.message.send requires "to" parameter`);
        if (!step.params.subject && !step.params.body) {
          warnings.push(`Step ${step.stepId}: email.message.send has no subject or body`);
        }
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
      'email': ['mail', 'correo', 'message', 'inbox', 'mailbox'],
      'send': ['enviar', 'compose', 'write', 'deliver', 'outgoing'],
      'read': ['leer', 'open', 'view', 'show', 'fetch'],
      'inbox': ['bandeja', 'received', 'incoming', 'unread'],
      'reply': ['responder', 'respond', 'answer', 're:'],
      'forward': ['reenviar', 'fwd', 'redirect'],
      'folder': ['carpeta', 'label', 'directory', 'mailbox'],
      'attachment': ['adjunto', 'attach', 'file', 'download'],
      'delete': ['eliminar', 'trash', 'remove', 'discard'],
      'search': ['buscar', 'find', 'filter', 'query'],
      'flag': ['marcar', 'mark', 'star', 'label', 'seen', 'unread'],
      'draft': ['borrador', 'save', 'template'],
      'move': ['mover', 'transfer', 'archive', 'organize'],
    };
  }

  // ─── Plan Normalizers ──────────────────────────────────────────────────────

  planNormalizers(): PlanNormalizer[] {
    return [
      // Fix shorthand operationIds: "read" → "email.message.read", "list folders" → "email.folder.list"
      (plan, fixes) => {
        const SHORTHAND_MAP: Record<string, string> = {
          'read': 'email.message.read',
          'send': 'email.message.send',
          'write': 'email.message.write',
          'reply': 'email.message.reply',
          'forward': 'email.message.forward',
          'delete': 'email.message.delete',
          'move': 'email.message.move',
          'copy': 'email.message.copy',
          'search': 'email.envelope.search',
          'list': 'email.envelope.list',
        };
        for (const step of plan.steps) {
          // Direct shorthand
          if (SHORTHAND_MAP[step.operationId]) {
            step.operationId = SHORTHAND_MAP[step.operationId];
            fixes.push('expanded shorthand to full email operationId');
            continue;
          }
          // Missing email. prefix
          if (!step.operationId.startsWith('email.')) {
            const cleaned = step.operationId.replace(/\s+/g, '.').replace(/-/g, '.');
            step.operationId = `email.${cleaned}`;
            fixes.push('added email. prefix to operationId');
          }
        }
      },
      // Fix spaces and hyphens in operationId: "email.message read" → "email.message.read"
      (plan, fixes) => {
        for (const step of plan.steps) {
          if (step.operationId.includes(' ')) {
            step.operationId = step.operationId.replace(/\s+/g, '.');
            fixes.push('replaced spaces with dots in operationId');
          }
        }
      },
      // Rename common param mistakes
      (plan, fixes) => {
        for (const step of plan.steps) {
          const p = step.params;

          // "recipient" or "email" or "address" → "to" for send
          if (step.operationId === 'email.message.send' || step.operationId === 'email.message.write') {
            if ((p['recipient'] || p['email'] || p['address'] || p['to_address']) && !p['to']) {
              p['to'] = p['recipient'] || p['email'] || p['address'] || p['to_address'];
              delete p['recipient'];
              delete p['email'];
              delete p['address'];
              delete p['to_address'];
              fixes.push('renamed recipient/email/address→to for send');
            }
            if (p['title'] && !p['subject']) {
              p['subject'] = p['title'];
              delete p['title'];
              fixes.push('renamed title→subject for send');
            }
            if (p['content'] && !p['body']) {
              p['body'] = p['content'];
              delete p['content'];
              fixes.push('renamed content→body for send');
            }
            if (p['message'] && !p['body']) {
              p['body'] = p['message'];
              delete p['message'];
              fixes.push('renamed message→body for send');
            }
          }

          // "message_id" or "envelope_id" or "uid" → "id" for read/reply/forward/delete
          const ID_OPS = [
            'email.message.read', 'email.message.reply', 'email.message.forward',
            'email.message.delete', 'email.message.move', 'email.message.copy',
            'email.flag.add', 'email.flag.remove',
          ];
          if (ID_OPS.includes(step.operationId)) {
            if ((p['message_id'] || p['uid'] || p['envelope_id'] || p['msg_id']) && !p['id']) {
              p['id'] = p['message_id'] || p['uid'] || p['envelope_id'] || p['msg_id'];
              delete p['message_id'];
              delete p['uid'];
              delete p['envelope_id'];
              delete p['msg_id'];
              fixes.push('renamed message_id/uid→id');
            }
          }

          // "destination" or "folder_name" → "target" for move/copy
          if (step.operationId === 'email.message.move' || step.operationId === 'email.message.copy') {
            if ((p['destination'] || p['folder_name'] || p['target_folder']) && !p['target']) {
              p['target'] = p['destination'] || p['folder_name'] || p['target_folder'];
              delete p['destination'];
              delete p['folder_name'];
              delete p['target_folder'];
              fixes.push('renamed destination→target for move/copy');
            }
          }

          // "name" or "folder_name" → "name" for folder operations (already correct key)
          // "flag" (singular) → "flags" for flag operations
          if (step.operationId === 'email.flag.add' || step.operationId === 'email.flag.remove') {
            if (p['flag'] && !p['flags']) {
              p['flags'] = p['flag'];
              delete p['flag'];
              fixes.push('renamed flag→flags');
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

// ─── Built-in Knowledge (18 Email operations) ────────────────────────────────

function k(
  id: string, opId: string, display: string, desc: string, cat: string,
  params: Array<{ name: string; type: string; description: string; required: boolean }>,
  tags: string[] = [],
): Knowledge {
  return {
    id: `email-${id}`, type: 'knowledge', domainId: 'email',
    createdAt: '', updatedAt: '', tags: ['email', cat, ...tags],
    operationId: opId, displayName: display, description: desc,
    category: cat, parameters: params,
  };
}

const EMAIL_KNOWLEDGE: Knowledge[] = [
  // ── Folders ──
  k('folder-list', 'email.folder.list', 'List folders', 'List all email folders/mailboxes', 'folder', [], ['list', 'mailbox']),
  k('folder-create', 'email.folder.create', 'Create folder', 'Create a new email folder/mailbox', 'folder', [
    { name: 'name', type: 'string', description: 'Folder name to create', required: true },
  ], ['create', 'mkdir']),
  k('folder-delete', 'email.folder.delete', 'Delete folder', 'Delete an email folder/mailbox', 'folder', [
    { name: 'name', type: 'string', description: 'Folder name to delete', required: true },
  ], ['delete', 'remove']),

  // ── Envelopes (listing/searching) ──
  k('envelope-list', 'email.envelope.list', 'List emails', 'List email envelopes (from, subject, date, flags) in a folder', 'envelope', [
    { name: 'folder', type: 'string', description: 'Folder to list (default: INBOX)', required: false },
    { name: 'page', type: 'number', description: 'Page number for pagination', required: false },
    { name: 'page-size', type: 'number', description: 'Results per page (default: 10)', required: false },
  ], ['list', 'inbox']),
  k('envelope-search', 'email.envelope.search', 'Search emails', 'Search emails by subject, from, to, date, or flags. Uses IMAP search syntax.', 'envelope', [
    { name: 'query', type: 'string', description: 'Search query (e.g., \'subject "invoice"\', \'from "john@"\', \'not flag Seen\')', required: true },
    { name: 'folder', type: 'string', description: 'Folder to search in (default: INBOX)', required: false },
    { name: 'page-size', type: 'number', description: 'Max results (default: 10)', required: false },
  ], ['search', 'find', 'filter']),

  // ── Messages ──
  k('message-read', 'email.message.read', 'Read email', 'Read the full content of an email message by its ID', 'message', [
    { name: 'id', type: 'string', description: 'Message ID to read', required: true },
    { name: 'folder', type: 'string', description: 'Folder containing the message (default: INBOX)', required: false },
    { name: 'html', type: 'boolean', description: 'Read HTML version', required: false },
    { name: 'raw', type: 'boolean', description: 'Read raw MIME content', required: false },
  ], ['read', 'open', 'view', 'fetch']),
  k('message-send', 'email.message.send', 'Send email', 'Compose and send an email via SMTP', 'message', [
    { name: 'to', type: 'string', description: 'Recipient email address', required: true },
    { name: 'subject', type: 'string', description: 'Email subject line', required: true },
    { name: 'body', type: 'string', description: 'Email body text', required: true },
    { name: 'from', type: 'string', description: 'Sender address (default: configured account)', required: false },
    { name: 'cc', type: 'string', description: 'CC recipients (comma-separated)', required: false },
    { name: 'bcc', type: 'string', description: 'BCC recipients (comma-separated)', required: false },
    { name: 'attachment', type: 'string', description: 'File path to attach', required: false },
  ], ['send', 'compose', 'write', 'outgoing']),
  k('message-reply', 'email.message.reply', 'Reply to email', 'Reply to an email message', 'message', [
    { name: 'id', type: 'string', description: 'Message ID to reply to', required: true },
    { name: 'body', type: 'string', description: 'Reply body text', required: false },
    { name: 'all', type: 'boolean', description: 'Reply all (include all recipients)', required: false },
    { name: 'folder', type: 'string', description: 'Folder containing the message', required: false },
  ], ['reply', 'respond', 'answer']),
  k('message-forward', 'email.message.forward', 'Forward email', 'Forward an email message to another recipient', 'message', [
    { name: 'id', type: 'string', description: 'Message ID to forward', required: true },
    { name: 'to', type: 'string', description: 'Recipient to forward to', required: true },
    { name: 'folder', type: 'string', description: 'Folder containing the message', required: false },
  ], ['forward', 'fwd', 'redirect']),
  k('message-copy', 'email.message.copy', 'Copy email to folder', 'Copy an email message to another folder', 'message', [
    { name: 'id', type: 'string', description: 'Message ID to copy', required: true },
    { name: 'target', type: 'string', description: 'Destination folder name', required: true },
    { name: 'folder', type: 'string', description: 'Source folder (default: INBOX)', required: false },
  ], ['copy', 'duplicate']),
  k('message-move', 'email.message.move', 'Move email to folder', 'Move an email message to another folder (e.g., Archive, Trash)', 'message', [
    { name: 'id', type: 'string', description: 'Message ID to move', required: true },
    { name: 'target', type: 'string', description: 'Destination folder name (e.g., "Archive", "Trash")', required: true },
    { name: 'folder', type: 'string', description: 'Source folder (default: INBOX)', required: false },
  ], ['move', 'archive', 'organize']),
  k('message-delete', 'email.message.delete', 'Delete email', 'Permanently delete an email message', 'message', [
    { name: 'id', type: 'string', description: 'Message ID to delete', required: true },
    { name: 'folder', type: 'string', description: 'Folder containing the message (default: INBOX)', required: false },
  ], ['delete', 'remove', 'trash']),

  // ── Flags ──
  k('flag-add', 'email.flag.add', 'Add flag', 'Add a flag to a message (Seen, Flagged, Answered, Draft, Deleted)', 'flag', [
    { name: 'id', type: 'string', description: 'Message ID to flag', required: true },
    { name: 'flags', type: 'string', description: 'Flag(s) to add: Seen, Flagged, Answered, Draft, Deleted', required: true },
    { name: 'folder', type: 'string', description: 'Folder containing the message', required: false },
  ], ['mark', 'seen', 'star', 'read']),
  k('flag-remove', 'email.flag.remove', 'Remove flag', 'Remove a flag from a message', 'flag', [
    { name: 'id', type: 'string', description: 'Message ID to unflag', required: true },
    { name: 'flags', type: 'string', description: 'Flag(s) to remove: Seen, Flagged, Answered, Draft, Deleted', required: true },
    { name: 'folder', type: 'string', description: 'Folder containing the message', required: false },
  ], ['unmark', 'unread', 'unstar']),

  // ── Attachments ──
  k('attachment-download', 'email.attachment.download', 'Download attachment', 'Download all attachments from an email message', 'attachment', [
    { name: 'id', type: 'string', description: 'Message ID to download attachments from', required: true },
    { name: 'folder', type: 'string', description: 'Folder containing the message', required: false },
  ], ['download', 'save', 'file']),
];

// ─── Eval Goals ──────────────────────────────────────────────────────────────

export const EMAIL_EVAL_GOALS = [
  {
    goal: 'List all email folders',
    domainId: 'email',
    expectedOps: ['email.folder.list'],
    complexity: 'simple' as const,
  },
  {
    goal: 'List unread emails in the inbox',
    domainId: 'email',
    expectedOps: ['email.envelope.search'],
    complexity: 'simple' as const,
  },
  {
    goal: 'Read email number 42 and download its attachments',
    domainId: 'email',
    expectedOps: ['email.message.read', 'email.attachment.download'],
    complexity: 'medium' as const,
  },
  {
    goal: 'Search for emails from john@example.com about "invoice", read the first one, and move it to Archive',
    domainId: 'email',
    expectedOps: ['email.envelope.search', 'email.message.read', 'email.message.move'],
    complexity: 'complex' as const,
  },
  {
    goal: 'Send an email to alice@example.com with subject "Meeting" and body "Tomorrow at 3pm"',
    domainId: 'email',
    expectedOps: ['email.message.send'],
    complexity: 'simple' as const,
  },
];
