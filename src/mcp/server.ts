/**
 * MCP Server for CTT-Shell
 *
 * Exposes the CTT pipeline as MCP tools over stdio (JSON-RPC 2.0).
 * Zero runtime dependencies — uses only Node.js built-ins.
 *
 * Tools:
 *  1. ctt_search       — TF-IDF search across all domains
 *  2. ctt_execute      — Full autonomous pipeline (recall → plan → execute → learn)
 *  3. ctt_extract      — Extract Knowledge from a domain
 *  4. ctt_list_domains — List registered domains with operation counts
 *  5. ctt_store_stats  — Store statistics
 *  6. ctt_recall       — Build CTT context for a goal (without executing)
 *  7. ctt_shell        — Execute shell commands with RBAC policy enforcement
 */

import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Store } from '../storage/store.js';
import { createExecutor } from '../shell/executor.js';
import { AuditLog } from '../shell/audit.js';
import type { ShellRole } from '../shell/policy.js';
import { SearchEngine } from '../search/tfidf.js';
import { DomainRegistry } from '../domain/registry.js';
import { AutonomousAgent } from '../agent/autonomous.js';
import { recall, contextToPrompt } from '../agent/recall.js';
import { CircuitBreaker } from '../guardrails/circuit-breaker.js';
import { createProvider } from '../llm/provider.js';
import type { ProviderType } from '../llm/provider.js';
import { EchoAdapter } from '../../domains/echo/adapter.js';
import { BrowserAdapter } from '../../domains/browser/index.js';
import { WordPressAdapter } from '../../domains/wordpress/index.js';
import { N8nAdapter } from '../../domains/n8n/index.js';
import { WpCliAdapter } from '../../domains/wp-cli/index.js';
import { GitAdapter } from '../../domains/git/index.js';
import { ContextLoader } from '../context/loader.js';

// ─── JSON-RPC 2.0 Types ─────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// MCP protocol constants
const JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'ctt_search',
    description: 'Search Knowledge, Skills, and Memories across all domains using TF-IDF. Returns relevant operations, patterns, and learnings for a given query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ctt_execute',
    description: 'Run the full CTT autonomous pipeline: recall context → LLM generates plan → normalize → validate → execute → learn. Requires an LLM provider configured via environment variables.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        goal: { type: 'string', description: 'Natural language goal to accomplish' },
        domain: { type: 'string', description: 'Target domain ID (default: auto-detect from first registered)' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'ctt_extract',
    description: 'Extract Knowledge entities from a domain. For domains connected to live services (WordPress, n8n), this discovers endpoints/operations from the running instance.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Domain ID to extract from (echo, browser, wordpress, n8n)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'ctt_list_domains',
    description: 'List all registered domain adapters with their names and available operation counts.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'ctt_store_stats',
    description: 'Show CTT memory store statistics: count of Knowledge, Skills, Memories, and Profiles per entity type.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'ctt_recall',
    description: 'Build CTT context for a goal without executing. Returns the Knowledge operations, Skill patterns, Memories, and anti-patterns that would be injected into an LLM prompt. Useful for understanding what context CTT provides.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        goal: { type: 'string', description: 'Natural language goal to build context for' },
        compact: { type: 'boolean', description: 'Use compact format for small models (default: false)' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'ctt_shell',
    description: 'Execute a shell command with RBAC policy enforcement, audit logging, and output capture. The command is validated against the configured role (readonly/dev/admin) before execution. Dangerous commands are blocked automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute (e.g., "ls -la", "git status", "npm test")' },
        role: { type: 'string', description: 'RBAC role: "readonly" (safe reads only), "dev" (development commands), "admin" (all commands). Default: "dev"', enum: ['readonly', 'dev', 'admin'] },
        cwd: { type: 'string', description: 'Working directory (default: current directory)' },
        validate_only: { type: 'boolean', description: 'If true, only validate the command without executing it (default: false)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ctt_context',
    description: 'Manage user-provided business context (knowledge base). Add text, load files, list entries, or remove context that enriches LLM prompts with domain-specific background information.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', description: 'Action to perform', enum: ['add_text', 'add_file', 'list', 'remove', 'clear', 'load_dir'] },
        text: { type: 'string', description: 'Text content to add (for add_text action)' },
        title: { type: 'string', description: 'Title for the context entry (optional for add_text)' },
        file: { type: 'string', description: 'File path to load (for add_file action)' },
        directory: { type: 'string', description: 'Directory path (for load_dir action, default: .ctt-shell/context/)' },
        id: { type: 'string', description: 'Entry ID to remove (for remove action)' },
        category: { type: 'string', description: 'Category for grouping (e.g., product, policy, faq)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for search boosting' },
      },
      required: ['action'],
    },
  },
];

// ─── Infrastructure Setup ────────────────────────────────────────────────────

const CTT_ROOT = join(process.cwd(), '.ctt-shell');
const STORE_ROOT = join(CTT_ROOT, 'store');
const CONFIG_PATH = join(CTT_ROOT, 'config.json');

function loadConfig(): Record<string, string> {
  const config: Record<string, string> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      Object.assign(config, JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')));
    } catch { /* ignore */ }
  }
  return config;
}

function createInfra() {
  const store = new Store({ root: STORE_ROOT });
  const search = new SearchEngine();
  const domains = new DomainRegistry(store, search);

  domains.register(new EchoAdapter());
  domains.register(new BrowserAdapter());
  domains.register(new WordPressAdapter());
  domains.register(new N8nAdapter());
  domains.register(new WpCliAdapter());
  domains.register(new GitAdapter());
  domains.rebuildIndex();

  // Auto-load user context from .ctt-shell/context/ if it exists
  const contextLoader = new ContextLoader(store, search);
  const contextDir = join(CTT_ROOT, 'context');
  contextLoader.loadDirectory(contextDir);
  contextLoader.rebuildIndex();

  return { store, search, domains, contextLoader };
}

function getLlmProvider(): { provider: ProviderType; config: Record<string, unknown> } | null {
  const cfg = loadConfig();
  const cfKey = process.env.CF_API_KEY || cfg.cfApiKey;
  const cfAccount = process.env.CF_ACCOUNT_ID || cfg.cfAccountId;

  if (process.env.ANTHROPIC_API_KEY) return { provider: 'claude', config: { apiKey: process.env.ANTHROPIC_API_KEY } };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', config: { apiKey: process.env.OPENAI_API_KEY } };
  if (cfKey && cfAccount) return { provider: 'cloudflare', config: { apiKey: cfKey, accountId: cfAccount, model: cfg.cfModel, gateway: cfg.cfGateway } };
  if (process.env.OLLAMA_MODEL) return { provider: 'ollama', config: { model: process.env.OLLAMA_MODEL } };
  return null;
}

// ─── Tool Handlers ───────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>, infra: ReturnType<typeof createInfra>) => Promise<unknown>;

const handlers: Record<string, ToolHandler> = {
  async ctt_search(args, { search }) {
    const query = args.query as string;
    const limit = (args.limit as number) || 10;
    const results = search.embeddingsEnabled
      ? await search.hybridSearch(query, limit)
      : search.search(query, limit);

    return results.map(r => {
      const e = r.entity as unknown as Record<string, unknown>;
      return {
        score: Number(r.score.toFixed(3)),
        type: e.type,
        domainId: e.domainId,
        id: e.id,
        operationId: e.operationId ?? undefined,
        name: e.displayName ?? e.name ?? e.operationId ?? (e.content as string)?.slice(0, 80),
        description: (e.description as string)?.slice(0, 200) ?? (e.content as string)?.slice(0, 200),
        tags: e.tags,
      };
    });
  },

  async ctt_execute(args, infra) {
    const goal = args.goal as string;
    const domainId = args.domain as string | undefined;

    const llmConfig = getLlmProvider();
    if (!llmConfig) {
      throw new Error('No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, CF_API_KEY+CF_ACCOUNT_ID, or OLLAMA_MODEL.');
    }

    const llm = createProvider(llmConfig.provider, llmConfig.config);
    const agent = new AutonomousAgent({
      store: infra.store,
      search: infra.search,
      domains: infra.domains,
      llm,
    });

    const result = await agent.run(goal, domainId);

    return {
      success: result.success,
      retries: result.retries,
      error: result.error ?? undefined,
      plan: result.plan ? {
        goal: result.plan.goal,
        stepCount: result.plan.steps.length,
        steps: result.plan.steps.map(s => ({
          stepId: s.stepId,
          operationId: s.operationId,
          description: s.description,
        })),
      } : undefined,
      execution: result.result ? {
        success: result.result.success,
        durationMs: result.result.totalDurationMs,
        steps: result.result.steps.map(s => ({
          stepId: s.stepId,
          operationId: s.operationId,
          success: s.success,
          durationMs: s.durationMs,
          error: s.error ?? undefined,
        })),
      } : undefined,
      events: result.events.map(e => `[${e.phase}] ${e.message}`),
    };
  },

  async ctt_extract(args, { domains }) {
    const domainId = args.domain as string;
    if (!domains.has(domainId)) {
      throw new Error(`Domain not found: "${domainId}". Available: ${domains.list().join(', ')}`);
    }
    const count = await domains.extractKnowledge(domainId);
    return { domain: domainId, extracted: count };
  },

  async ctt_list_domains(_args, { domains, store }) {
    return domains.list().map(id => {
      const adapter = domains.get(id);
      const knowledge = store.findBy('knowledge', (e) => e.domainId === id);
      return {
        id,
        name: adapter?.name ?? 'Unknown',
        knowledgeCount: knowledge.length,
      };
    });
  },

  async ctt_store_stats(_args, { store, domains }) {
    const stats = store.stats();
    return {
      ...stats,
      domains: domains.list(),
    };
  },

  async ctt_recall(args, { search, store }) {
    const goal = args.goal as string;
    const compact = (args.compact as boolean) ?? false;
    const circuitBreaker = new CircuitBreaker(store);
    const ctx = await recall(goal, search, circuitBreaker, { compact });

    return {
      knowledge: ctx.knowledge.map(k => ({
        operationId: k.operationId,
        displayName: k.displayName,
        category: k.category,
        domainId: k.domainId,
        paramCount: k.parameters.length,
      })),
      skills: ctx.skills.map(s => ({
        name: s.name,
        goal: s.goal,
        status: s.status,
        stepCount: s.steps.length,
      })),
      memories: ctx.memories.map(m => ({
        category: m.category,
        content: m.content.slice(0, 200),
        resolution: m.resolution?.slice(0, 200),
      })),
      antiPatterns: ctx.antiPatterns,
      prompt: contextToPrompt(ctx, compact),
    };
  },

  async ctt_shell(args) {
    const command = args.command as string;
    const role = (args.role as ShellRole) || 'dev';
    const cwd = (args.cwd as string) || process.cwd();
    const validateOnly = (args.validate_only as boolean) ?? false;

    const audit = new AuditLog(join(CTT_ROOT, 'logs'));
    const executor = createExecutor(role, cwd, audit);

    if (validateOnly) {
      const check = executor.validate(command);
      return {
        command,
        role,
        allowed: check.allowed,
        reason: check.reason,
        warnings: check.warnings,
      };
    }

    const result = executor.exec(command);
    return {
      executed: result.executed,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 50_000), // Limit for MCP response
      stderr: result.stderr.slice(0, 10_000),
      durationMs: result.durationMs,
      command: result.command,
      role,
      denied: result.denyReason ? true : undefined,
      denyReason: result.denyReason,
      truncated: result.truncated,
    };
  },

  async ctt_context(args, infra) {
    const action = args.action as string;
    const loader = infra.contextLoader;

    switch (action) {
      case 'add_text': {
        const text = args.text as string;
        if (!text) return { error: 'Missing "text" parameter' };
        const title = args.title as string | undefined;
        const category = args.category as string | undefined;
        const tags = (args.tags as string[]) || [];
        const entry = loader.addText(text, tags, category, title);
        loader.addToSearchIndex([entry]);
        return { id: entry.id, title: entry.displayName, message: 'Context entry added' };
      }
      case 'add_file': {
        const file = args.file as string;
        if (!file) return { error: 'Missing "file" parameter' };
        const entries = loader.loadFile(file);
        loader.addToSearchIndex(entries);
        return { count: entries.length, entries: entries.map(e => ({ id: e.id, title: e.displayName })) };
      }
      case 'list': {
        const entries = loader.list();
        return {
          count: entries.length,
          entries: entries.map(e => ({
            id: e.id,
            title: e.displayName,
            category: e.category,
            preview: e.description.slice(0, 120),
            source: e.metadata?.source,
          })),
        };
      }
      case 'remove': {
        const id = args.id as string;
        if (!id) return { error: 'Missing "id" parameter' };
        const removed = loader.remove(id);
        if (removed) loader.rebuildIndex();
        return { removed, id };
      }
      case 'clear': {
        const count = loader.clear();
        loader.rebuildIndex();
        return { cleared: count };
      }
      case 'load_dir': {
        const dir = (args.directory as string) || join(CTT_ROOT, 'context');
        const entries = loader.loadDirectory(dir);
        loader.addToSearchIndex(entries);
        return { count: entries.length, directory: dir, entries: entries.map(e => ({ id: e.id, title: e.displayName })) };
      }
      default:
        return { error: `Unknown action: ${action}. Use: add_text, add_file, list, remove, clear, load_dir` };
    }
  },
};

// ─── MCP Server (JSON-RPC 2.0 over stdio) ───────────────────────────────────

export class McpServer {
  private infra: ReturnType<typeof createInfra>;

  constructor() {
    this.infra = createInfra();
  }

  /** Handle a single JSON-RPC request */
  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      switch (req.method) {
        case 'initialize':
          return this.respond(req.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'ctt-shell',
              version: '0.1.0',
            },
          });

        case 'notifications/initialized':
          // Client acknowledges initialization — no response needed for notifications
          // but since we received it as a request with an id, respond
          return this.respond(req.id, {});

        case 'tools/list':
          return this.respond(req.id, { tools: TOOLS });

        case 'tools/call': {
          const params = req.params as { name: string; arguments?: Record<string, unknown> };
          const toolName = params.name;
          const toolArgs = params.arguments ?? {};

          const handler = handlers[toolName];
          if (!handler) {
            return this.respondError(req.id, -32602, `Unknown tool: ${toolName}`);
          }

          try {
            const result = await handler(toolArgs, this.infra);
            return this.respond(req.id, {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return this.respond(req.id, {
              content: [{ type: 'text', text: `Error: ${msg}` }],
              isError: true,
            });
          }
        }

        default:
          return this.respondError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.respondError(req.id, -32603, `Internal error: ${msg}`);
    }
  }

  /** Start the stdio transport — reads JSON-RPC from stdin, writes to stdout */
  async start(): Promise<void> {
    const rl = createInterface({ input: process.stdin, terminal: false });

    // Use content-length based framing for MCP protocol
    let buffer = '';

    process.stdin.setEncoding('utf-8');
    // Remove readline, use raw stdin with Content-Length framing
    rl.close();

    process.stdin.on('data', async (chunk: string) => {
      buffer += chunk;

      // Process all complete messages in buffer
      while (true) {
        // Look for Content-Length header
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;

        const header = buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Skip malformed header
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }

        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;

        if (buffer.length < bodyEnd) break; // Wait for more data

        const body = buffer.slice(bodyStart, bodyEnd);
        buffer = buffer.slice(bodyEnd);

        try {
          const request = JSON.parse(body) as JsonRpcRequest;

          // Notifications (no id) don't get responses
          if (request.id === undefined || request.id === null) {
            // Still process it for side effects (e.g., notifications/initialized)
            continue;
          }

          const response = await this.handleRequest(request);
          this.send(response);
        } catch {
          this.send(this.respondError(null, -32700, 'Parse error'));
        }
      }
    });

    process.stdin.on('end', () => {
      process.exit(0);
    });

    // Log to stderr (stdout is reserved for MCP protocol)
    process.stderr.write('ctt-shell MCP server started (stdio)\n');
  }

  private send(msg: JsonRpcResponse | JsonRpcNotification): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    process.stdout.write(header + body);
  }

  private respond(id: number | string | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: JSONRPC_VERSION, id: id!, result };
  }

  private respondError(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcResponse {
    return { jsonrpc: JSONRPC_VERSION, id: id!, error: { code, message, data } };
  }
}

/** Start MCP server (called from CLI) */
export async function startMcpServer(): Promise<void> {
  const server = new McpServer();
  await server.start();
}
