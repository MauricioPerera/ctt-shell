/**
 * WP-CLI Domain Adapter — controls WordPress via terminal commands.
 *
 * Uses the Shell Engine to execute `wp` commands with RBAC policy.
 * Discovers available commands via `wp help --format=json` or falls back
 * to built-in definitions for 25+ common operations.
 *
 * operationId format: "wp.<group>.<subcommand>" e.g. "wp.post.create"
 *
 * Advantages over REST API adapter:
 * - No API key or Application Password needed
 * - Uses local server authentication
 * - Access to admin-only commands (plugin install, db export, search-replace)
 * - Ideal for DevOps, CI/CD, and local development
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

export interface WpCliAdapterConfig {
  /** Path to WordPress installation (for --path flag) */
  wpPath?: string;
  /** Shell RBAC role (default: 'dev') */
  role?: ShellRole;
  /** Working directory for shell commands */
  cwd?: string;
  /** Audit log directory */
  auditDir?: string;
  /** Custom wp binary path (default: 'wp') */
  wpBinary?: string;
}

// Commands that require admin role
const ADMIN_COMMANDS = new Set([
  'wp.plugin.install', 'wp.plugin.delete', 'wp.plugin.activate', 'wp.plugin.deactivate',
  'wp.theme.install', 'wp.theme.delete', 'wp.theme.activate',
  'wp.core.update', 'wp.core.install',
  'wp.db.export', 'wp.db.import', 'wp.db.reset',
  'wp.search-replace',
  'wp.config.set',
]);

export class WpCliAdapter implements DomainAdapter {
  readonly id = 'wp-cli';
  readonly name = 'WordPress (WP-CLI)';
  private config: WpCliAdapterConfig;
  private executor: ShellExecutor;
  private discoveredKnowledge: Knowledge[] | null = null;

  constructor(config?: WpCliAdapterConfig) {
    this.config = config ?? {};
    const auditDir = config?.auditDir || join(process.cwd(), '.ctt-shell', 'logs');
    const audit = new AuditLog(auditDir);
    this.executor = createExecutor(config?.role ?? 'dev', config?.cwd ?? process.cwd(), audit);
  }

  // ─── Knowledge Extraction ──────────────────────────────────────────────────

  async extractKnowledge(): Promise<Knowledge[]> {
    // Try live discovery first
    const discovered = await this.discoverFromCli();
    if (discovered.length > 0) {
      this.discoveredKnowledge = [...WPCLI_KNOWLEDGE, ...discovered];
      // Deduplicate by operationId
      const seen = new Set<string>();
      return this.discoveredKnowledge.filter(k => {
        if (seen.has(k.operationId)) return false;
        seen.add(k.operationId);
        return true;
      });
    }
    return WPCLI_KNOWLEDGE;
  }

  /** Discover commands from a live WP-CLI installation */
  private async discoverFromCli(): Promise<Knowledge[]> {
    const wp = this.wpCmd();
    const result = this.executor.exec(`${wp} cli cmd-dump --format=json`);

    if (!result.executed || result.exitCode !== 0) return [];

    try {
      const dump = JSON.parse(result.stdout);
      return this.parseCmdDump(dump);
    } catch {
      return [];
    }
  }

  /** Parse wp cli cmd-dump JSON into Knowledge entities */
  private parseCmdDump(dump: WpCmdDump): Knowledge[] {
    const knowledge: Knowledge[] = [];

    const walk = (node: WpCmdDump, prefix: string) => {
      if (node.subcommands) {
        for (const sub of node.subcommands) {
          const subName = sub.name || 'unknown';
          const cmdPath = prefix ? `${prefix}.${subName}` : subName;
          const operationId = `wp.${cmdPath}`;

          // Only leaf commands (those with synopsis/description)
          if (sub.description && !sub.subcommands?.length) {
            const params = (sub.synopsis || []).map((s: WpSynopsis) => ({
              name: s.name || s.type,
              type: s.type === 'flag' ? 'boolean' : 'string',
              description: s.description || `${s.type} parameter`,
              required: !s.optional,
            }));

            knowledge.push({
              id: `wp-cli-${cmdPath.replace(/\./g, '-')}`,
              type: 'knowledge',
              domainId: 'wp-cli',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              tags: ['wp-cli', ...cmdPath.split('.')],
              operationId,
              displayName: `wp ${cmdPath.replace(/\./g, ' ')}`,
              description: sub.description,
              category: cmdPath.split('.')[0],
              parameters: params,
            });
          }

          // Recurse into subcommands
          if (sub.subcommands?.length) {
            walk(sub, cmdPath);
          }
        }
      }
    };

    walk(dump, '');
    return knowledge;
  }

  // ─── Execution ─────────────────────────────────────────────────────────────

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    const start = Date.now();
    const outputs = new Map<string, unknown>();
    const stepResults: StepResult[] = [];

    for (const step of plan.steps) {
      const stepStart = Date.now();

      try {
        // Build wp command from step
        const cmd = this.buildCommand(step, outputs);

        // Determine role: admin commands get elevated if configured
        const needsAdmin = ADMIN_COMMANDS.has(step.operationId);
        let executor = this.executor;
        if (needsAdmin && this.config.role !== 'admin') {
          // Create a one-off admin executor for this command
          const auditDir = this.config.auditDir || join(process.cwd(), '.ctt-shell', 'logs');
          executor = createExecutor('admin', this.config.cwd ?? process.cwd(), new AuditLog(auditDir));
        }

        const result = executor.exec(cmd);

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
      domainId: 'wp-cli',
      steps: stepResults,
      totalDurationMs: Date.now() - start,
      error: success ? undefined : stepResults.find(s => !s.success)?.error,
    };
  }

  /** Build a wp CLI command string from an execution step */
  private buildCommand(step: ExecutionStep, outputs: Map<string, unknown>): string {
    const wp = this.wpCmd();
    // operationId format: wp.post.create → wp post create
    const subcommand = step.operationId.replace(/^wp\./, '').replace(/\./g, ' ');
    const parts = [wp, subcommand];

    // Resolve params with {{ref.field}} substitution
    const resolved = this.resolveRefs(step.params, outputs);

    // Build flags from params
    for (const [key, value] of Object.entries(resolved)) {
      if (value === undefined || value === null) continue;

      if (typeof value === 'boolean') {
        if (value) parts.push(`--${key}`);
      } else if (key === '_positional') {
        // Positional argument (e.g., plugin name for wp plugin install)
        parts.push(this.shellEscape(String(value)));
      } else {
        parts.push(`--${key}=${this.shellEscape(String(value))}`);
      }
    }

    // Always request machine-readable output where applicable
    if (!resolved['format'] && !resolved['porcelain'] && this.supportsFormat(step.operationId)) {
      parts.push('--format=json');
    }

    // Add --porcelain for create operations to get just the ID
    if (step.operationId.endsWith('.create') && !resolved['porcelain'] && !resolved['format']) {
      // Replace --format=json with --porcelain for creates
      const formatIdx = parts.indexOf('--format=json');
      if (formatIdx >= 0) parts.splice(formatIdx, 1);
      parts.push('--porcelain');
    }

    return parts.join(' ');
  }

  /** Parse wp CLI output into structured data */
  private parseOutput(stdout: string, step: ExecutionStep): unknown {
    const trimmed = stdout.trim();

    // Porcelain output (just an ID)
    if (step.operationId.endsWith('.create') && /^\d+$/.test(trimmed)) {
      return { id: parseInt(trimmed, 10) };
    }

    // Try JSON parse
    try {
      return JSON.parse(trimmed);
    } catch {
      // Return as text
      return { output: trimmed };
    }
  }

  /** Check if a command supports --format flag */
  private supportsFormat(operationId: string): boolean {
    const formatOps = ['list', 'get', 'search', 'check', 'status'];
    return formatOps.some(op => operationId.endsWith(`.${op}`));
  }

  /** Get the wp binary command (with optional --path) */
  private wpCmd(): string {
    const binary = this.config.wpBinary || 'wp';
    return this.config.wpPath ? `${binary} --path=${this.shellEscape(this.config.wpPath)}` : binary;
  }

  /** Escape a value for shell */
  private shellEscape(value: string): string {
    if (/^[a-zA-Z0-9._\-/:@]+$/.test(value)) return value;
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  validate(plan: ExecutionPlan): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const knownOps = new Set([
      ...WPCLI_KNOWLEDGE.map(k => k.operationId),
      ...(this.discoveredKnowledge?.map(k => k.operationId) || []),
    ]);

    for (const step of plan.steps) {
      if (!step.operationId.startsWith('wp.')) {
        errors.push(`Step ${step.stepId}: operationId "${step.operationId}" must start with "wp."`);
        continue;
      }

      if (!knownOps.has(step.operationId)) {
        warnings.push(`Step ${step.stepId}: unknown operation "${step.operationId}" (may work if WP-CLI has it)`);
      }

      if (ADMIN_COMMANDS.has(step.operationId)) {
        warnings.push(`Step ${step.stepId}: "${step.operationId}" requires admin privileges`);
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
      'post': ['article', 'blog', 'content', 'page', 'entry'],
      'plugin': ['extension', 'addon', 'module', 'install'],
      'theme': ['template', 'design', 'skin', 'appearance'],
      'user': ['account', 'member', 'author', 'admin'],
      'media': ['image', 'upload', 'file', 'attachment'],
      'option': ['setting', 'config', 'preference'],
      'database': ['db', 'sql', 'mysql', 'export', 'import'],
      'search': ['find', 'replace', 'sed', 'grep'],
      'cache': ['flush', 'clear', 'transient'],
      'cron': ['schedule', 'event', 'job'],
      'woocommerce': ['wc', 'shop', 'product', 'order', 'ecommerce'],
      'menu': ['navigation', 'nav'],
      'widget': ['sidebar', 'block'],
      'rewrite': ['permalink', 'slug', 'url'],
    };
  }

  // ─── Plan Normalizers ──────────────────────────────────────────────────────

  planNormalizers(): PlanNormalizer[] {
    return [
      // Fix shorthand operationIds: "post create" → "wp.post.create"
      (plan, fixes) => {
        for (const step of plan.steps) {
          if (!step.operationId.startsWith('wp.')) {
            // Try to add wp. prefix
            const withPrefix = `wp.${step.operationId.replace(/\s+/g, '.')}`;
            step.operationId = withPrefix;
            fixes.push(`added wp. prefix to "${step.operationId}"`);
          }
        }
      },
      // Fix "wp post" → "wp.post", "wp-post-create" → "wp.post.create"
      (plan, fixes) => {
        for (const step of plan.steps) {
          if (step.operationId.includes(' ')) {
            step.operationId = step.operationId.replace(/\s+/g, '.');
            fixes.push(`replaced spaces with dots in operationId`);
          }
          if (step.operationId.includes('-') && !step.operationId.includes('search-replace')) {
            step.operationId = step.operationId.replace(/-/g, '.');
            fixes.push(`replaced hyphens with dots in operationId`);
          }
        }
      },
      // Rename common param mistakes
      (plan, fixes) => {
        for (const step of plan.steps) {
          const p = step.params;
          // "title" → "post_title" for wp.post.create
          if (step.operationId === 'wp.post.create' || step.operationId === 'wp.post.update') {
            if (p['title'] && !p['post_title']) {
              p['post_title'] = p['title'];
              delete p['title'];
              fixes.push('renamed title→post_title');
            }
            if (p['content'] && !p['post_content']) {
              p['post_content'] = p['content'];
              delete p['content'];
              fixes.push('renamed content→post_content');
            }
            if (p['status'] && !p['post_status']) {
              p['post_status'] = p['status'];
              delete p['status'];
              fixes.push('renamed status→post_status');
            }
          }
          // "name" → "_positional" for wp.plugin.install/activate
          if ((step.operationId.startsWith('wp.plugin.') || step.operationId.startsWith('wp.theme.'))
            && (p['name'] || p['plugin'] || p['theme']) && !p['_positional']) {
            p['_positional'] = p['name'] || p['plugin'] || p['theme'];
            delete p['name'];
            delete p['plugin'];
            delete p['theme'];
            fixes.push('moved name/plugin/theme to positional arg');
          }
        }
      },
    ];
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

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

// ─── Types for WP CLI cmd-dump ───────────────────────────────────────────────

interface WpSynopsis {
  name?: string;
  type: string;
  description?: string;
  optional?: boolean;
}

interface WpCmdDump {
  name?: string;
  description?: string;
  synopsis?: WpSynopsis[];
  subcommands?: WpCmdDump[];
}

// ─── Built-in Knowledge (25 common WP-CLI operations) ────────────────────────

function k(
  id: string, opId: string, display: string, desc: string, cat: string,
  params: Array<{ name: string; type: string; description: string; required: boolean }>,
  tags: string[] = [],
): Knowledge {
  return {
    id: `wp-cli-${id}`, type: 'knowledge', domainId: 'wp-cli',
    createdAt: '', updatedAt: '', tags: ['wp-cli', cat, ...tags],
    operationId: opId, displayName: display, description: desc,
    category: cat, parameters: params,
  };
}

const WPCLI_KNOWLEDGE: Knowledge[] = [
  // ── Posts ──
  k('post-create', 'wp.post.create', 'wp post create', 'Create a new post', 'post', [
    { name: 'post_title', type: 'string', description: 'Post title', required: true },
    { name: 'post_content', type: 'string', description: 'Post content', required: false },
    { name: 'post_status', type: 'string', description: 'Post status (draft, publish, pending)', required: false },
    { name: 'post_type', type: 'string', description: 'Post type (post, page, custom)', required: false },
    { name: 'post_author', type: 'number', description: 'Author user ID', required: false },
    { name: 'post_category', type: 'string', description: 'Comma-separated category IDs', required: false },
  ], ['create']),
  k('post-update', 'wp.post.update', 'wp post update', 'Update an existing post', 'post', [
    { name: '_positional', type: 'number', description: 'Post ID to update', required: true },
    { name: 'post_title', type: 'string', description: 'New title', required: false },
    { name: 'post_content', type: 'string', description: 'New content', required: false },
    { name: 'post_status', type: 'string', description: 'New status', required: false },
  ], ['update']),
  k('post-delete', 'wp.post.delete', 'wp post delete', 'Delete a post', 'post', [
    { name: '_positional', type: 'number', description: 'Post ID to delete', required: true },
    { name: 'force', type: 'boolean', description: 'Skip trash and force delete', required: false },
  ], ['delete']),
  k('post-list', 'wp.post.list', 'wp post list', 'List posts with filters', 'post', [
    { name: 'post_type', type: 'string', description: 'Post type (default: post)', required: false },
    { name: 'post_status', type: 'string', description: 'Filter by status', required: false },
    { name: 'posts_per_page', type: 'number', description: 'Number of posts', required: false },
    { name: 'fields', type: 'string', description: 'Comma-separated fields to display', required: false },
  ], ['list', 'query']),
  k('post-get', 'wp.post.get', 'wp post get', 'Get a single post by ID', 'post', [
    { name: '_positional', type: 'number', description: 'Post ID', required: true },
    { name: 'fields', type: 'string', description: 'Comma-separated fields', required: false },
  ], ['read']),

  // ── Taxonomy ──
  k('term-create', 'wp.term.create', 'wp term create', 'Create a taxonomy term (category, tag, etc.)', 'taxonomy', [
    { name: '_positional', type: 'string', description: 'Taxonomy name (category, post_tag, etc.)', required: true },
    { name: 'term', type: 'string', description: 'Term name', required: true },
    { name: 'slug', type: 'string', description: 'Term slug', required: false },
    { name: 'description', type: 'string', description: 'Term description', required: false },
    { name: 'parent', type: 'number', description: 'Parent term ID', required: false },
  ], ['create', 'category', 'tag']),
  k('term-list', 'wp.term.list', 'wp term list', 'List taxonomy terms', 'taxonomy', [
    { name: '_positional', type: 'string', description: 'Taxonomy name', required: true },
    { name: 'fields', type: 'string', description: 'Fields to display', required: false },
  ], ['list', 'category', 'tag']),

  // ── Users ──
  k('user-create', 'wp.user.create', 'wp user create', 'Create a new user', 'user', [
    { name: '_positional', type: 'string', description: 'User login name', required: true },
    { name: 'user_email', type: 'string', description: 'User email', required: true },
    { name: 'role', type: 'string', description: 'User role (subscriber, editor, admin)', required: false },
    { name: 'user_pass', type: 'string', description: 'User password', required: false },
    { name: 'display_name', type: 'string', description: 'Display name', required: false },
  ], ['create']),
  k('user-list', 'wp.user.list', 'wp user list', 'List users', 'user', [
    { name: 'role', type: 'string', description: 'Filter by role', required: false },
    { name: 'fields', type: 'string', description: 'Fields to display', required: false },
  ], ['list']),

  // ── Plugins ──
  k('plugin-install', 'wp.plugin.install', 'wp plugin install', 'Install a plugin from wordpress.org', 'plugin', [
    { name: '_positional', type: 'string', description: 'Plugin slug (e.g., woocommerce)', required: true },
    { name: 'activate', type: 'boolean', description: 'Activate after installing', required: false },
  ], ['install']),
  k('plugin-activate', 'wp.plugin.activate', 'wp plugin activate', 'Activate an installed plugin', 'plugin', [
    { name: '_positional', type: 'string', description: 'Plugin slug', required: true },
  ], ['activate']),
  k('plugin-deactivate', 'wp.plugin.deactivate', 'wp plugin deactivate', 'Deactivate a plugin', 'plugin', [
    { name: '_positional', type: 'string', description: 'Plugin slug', required: true },
  ], ['deactivate']),
  k('plugin-list', 'wp.plugin.list', 'wp plugin list', 'List installed plugins', 'plugin', [
    { name: 'status', type: 'string', description: 'Filter by status (active, inactive, must-use)', required: false },
    { name: 'fields', type: 'string', description: 'Fields to display', required: false },
  ], ['list']),

  // ── Themes ──
  k('theme-install', 'wp.theme.install', 'wp theme install', 'Install a theme', 'theme', [
    { name: '_positional', type: 'string', description: 'Theme slug', required: true },
    { name: 'activate', type: 'boolean', description: 'Activate after installing', required: false },
  ], ['install']),
  k('theme-activate', 'wp.theme.activate', 'wp theme activate', 'Activate a theme', 'theme', [
    { name: '_positional', type: 'string', description: 'Theme slug', required: true },
  ], ['activate']),
  k('theme-list', 'wp.theme.list', 'wp theme list', 'List installed themes', 'theme', [
    { name: 'status', type: 'string', description: 'Filter by status', required: false },
    { name: 'fields', type: 'string', description: 'Fields to display', required: false },
  ], ['list']),

  // ── Database ──
  k('db-export', 'wp.db.export', 'wp db export', 'Export the database to a SQL file', 'database', [
    { name: '_positional', type: 'string', description: 'Output file path (default: stdout)', required: false },
  ], ['export', 'backup']),
  k('db-import', 'wp.db.import', 'wp db import', 'Import a SQL file into the database', 'database', [
    { name: '_positional', type: 'string', description: 'SQL file path', required: true },
  ], ['import', 'restore']),

  // ── Options ──
  k('option-get', 'wp.option.get', 'wp option get', 'Get a WordPress option value', 'option', [
    { name: '_positional', type: 'string', description: 'Option name (e.g., blogname, siteurl)', required: true },
  ], ['read', 'setting']),
  k('option-update', 'wp.option.update', 'wp option update', 'Update a WordPress option', 'option', [
    { name: '_positional', type: 'string', description: 'Option name', required: true },
    { name: 'value', type: 'string', description: 'New value', required: true },
  ], ['update', 'setting']),

  // ── Search-Replace ──
  k('search-replace', 'wp.search-replace', 'wp search-replace', 'Search and replace in the database', 'maintenance', [
    { name: 'old', type: 'string', description: 'String to search for', required: true },
    { name: 'new', type: 'string', description: 'Replacement string', required: true },
    { name: 'dry-run', type: 'boolean', description: 'Preview changes without applying', required: false },
  ], ['find', 'replace', 'migrate']),

  // ── Cache ──
  k('cache-flush', 'wp.cache.flush', 'wp cache flush', 'Flush the WordPress object cache', 'cache', []),

  // ── Rewrite ──
  k('rewrite-flush', 'wp.rewrite.flush', 'wp rewrite flush', 'Flush rewrite rules (permalinks)', 'maintenance', [
    { name: 'hard', type: 'boolean', description: 'Perform a hard flush (update .htaccess)', required: false },
  ], ['permalink']),

  // ── WooCommerce (if wc cli available) ──
  k('wc-product-list', 'wp.wc.product.list', 'wp wc product list', 'List WooCommerce products', 'woocommerce', [
    { name: 'fields', type: 'string', description: 'Fields to display', required: false },
    { name: 'status', type: 'string', description: 'Product status', required: false },
  ], ['list', 'shop']),
  k('wc-order-list', 'wp.wc.order.list', 'wp wc order list', 'List WooCommerce orders', 'woocommerce', [
    { name: 'fields', type: 'string', description: 'Fields to display', required: false },
    { name: 'status', type: 'string', description: 'Order status', required: false },
  ], ['list', 'shop']),
];

// ─── Eval Goals ──────────────────────────────────────────────────────────────

export const WPCLI_EVAL_GOALS = [
  {
    goal: 'Create a new published blog post titled "Hello from CLI"',
    domainId: 'wp-cli',
    expectedOps: ['wp.post.create'],
    complexity: 'simple' as const,
  },
  {
    goal: 'List all active plugins',
    domainId: 'wp-cli',
    expectedOps: ['wp.plugin.list'],
    complexity: 'simple' as const,
  },
  {
    goal: 'Create a post, then create a category, then get the site title',
    domainId: 'wp-cli',
    expectedOps: ['wp.post.create', 'wp.term.create', 'wp.option.get'],
    complexity: 'medium' as const,
  },
  {
    goal: 'Export the database, then search-replace old-domain.com with new-domain.com, then flush rewrite rules',
    domainId: 'wp-cli',
    expectedOps: ['wp.db.export', 'wp.search-replace', 'wp.rewrite.flush'],
    complexity: 'complex' as const,
  },
  {
    goal: 'Install and activate the WooCommerce plugin',
    domainId: 'wp-cli',
    expectedOps: ['wp.plugin.install'],
    complexity: 'simple' as const,
  },
];
