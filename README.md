# ctt-shell

Universal AI agent framework that makes 3B parameter models compose and execute multi-step plans like 12B models.

**The thesis**: structured context at inference time substitutes for parameter count — *Context-Time Training*.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Zero Dependencies](https://img.shields.io/badge/runtime_deps-0-brightgreen)]()

## How it works

```
 "Create a post, assign a         ┌─────────────┐
  category, and upload media" ───→ │  CTT Memory  │ ← Knowledge, Skills, Memories
                                   └──────┬──────┘
                                          ▼
                                   ┌─────────────┐
                                   │  LLM (3B+)  │ ← Few-shot context + anti-patterns
                                   └──────┬──────┘
                                          ▼
                                   ┌─────────────┐
                                   │ Guard Rails  │ ← Normalize JSON, fix deps, retry
                                   └──────┬──────┘
                                          ▼
                                   ┌─────────────┐
                                   │   Execute    │ ← Domain adapter (WordPress, n8n, ...)
                                   └──────┬──────┘
                                          ▼
                                   ┌─────────────┐
                                   │    Learn     │ ← Save as Skill or Memory
                                   └─────────────┘
```

An agent receives a natural language goal, searches its CTT memory for relevant operations and patterns, asks any LLM to generate a plan, normalizes the output through battle-tested guard rails, executes it via a domain adapter, and learns from the result.

## Eval results

33 goals across 6 domains — **zero runtime dependencies**, just Node.js built-ins:

| Model | Size | JSON parse | Plan valid | Composed | Avg latency |
|-------|------|-----------|-----------|----------|-------------|
| Llama 3.2 (Cloudflare) | **3B** | 96% | 96% | **96%** | 1.5s |
| Gemma 3 (Cloudflare) | **12B** | 100% | 100% | **100%** | 4.2s |

The 3B model fails only on one complex 3-step goal. Every other goal — including WordPress WooCommerce workflows and n8n multi-node compositions — composes successfully at 3B.

## Quick start

```bash
# Clone and build
git clone https://github.com/MauricioPerera/ctt-shell.git
cd ctt-shell
npm install
npm run build

# Set up an LLM provider (pick one)
export CF_API_KEY="..."          # Cloudflare Workers AI (free tier, recommended for eval)
export CF_ACCOUNT_ID="..."
# or
export ANTHROPIC_API_KEY="..."   # Claude
# or
export OPENAI_API_KEY="..."      # OpenAI
# or
export OLLAMA_MODEL="qwen2.5:3b" # Local Ollama

# Run the echo domain (no external services needed)
node dist/src/cli/cli.js extract echo
node dist/src/cli/cli.js exec "create an item called hello"

# Run eval
node dist/src/cli/cli.js eval --domain echo
```

## Architecture

Six layers, bottom-up:

```
MCP Interface    → stdio | HTTP/SSE | CLI
Agent Layer      → Autonomous | Interactive | Eval Runner
Guard Rails      → Response Normalizer | Plan Normalizer | Circuit Breaker | Inline Retry | Sanitizer
Domain Layer     → DomainRegistry | DomainAdapter interface | Knowledge Resolver
CTT Memory       → Store (SHA-256) | Search (TF-IDF) | Skills Lifecycle
Shell Engine     → Parser | Executor | RBAC Policy (readonly/dev/admin) | Audit Log
```

### Shell engine

The shell layer gives LLM agents controlled access to the terminal:

- **Parser** — Tokenizes commands, handles quotes, pipes (`cmd1 | cmd2`), env vars (`KEY=val cmd`), detects redirects
- **RBAC Policy** — Three built-in roles restrict what the agent can do:
  - `readonly` — ls, cat, grep, git status/log/diff only
  - `dev` — git, node, npm, curl, mkdir, sed, awk, jq (blocks sudo, rm -rf /, force push, npm publish)
  - `admin` — all commands (still blocks rm -rf /, fork bombs)
- **Executor** — Runs via `child_process.execSync` with timeout, output limits, path sandboxing
- **Audit log** — Immutable JSONL log of every execution (allowed + denied) with timing and output previews

### CTT entity model

| Entity | Role | Example |
|--------|------|---------|
| **Knowledge** | Operation schemas | `POST:/wp/v2/posts` with params, types, descriptions |
| **Skill** | Proven patterns | "Create post + assign category" — lifecycle: experimental → proven → deprecated |
| **Memory** | Learnings | "Llama 3.2 fails to close JSON arrays" → inline retry with error feedback |
| **Profile** | Connections | WordPress instance URL + sanitized credential placeholders |

### Guard rails

These are the key to making small models work:

- **Response normalizer** — Strip thinking tags, extract JSON from code fences (even unclosed), fix trailing commas, single quotes, unquoted keys, auto-close truncated JSON to last complete object
- **Plan normalizer** — Fix out-of-bounds dependencies, self-loops, orphan chaining, type coercion, circular dependency breaking
- **Circuit breaker** — Block operations after N consecutive failures, inject anti-patterns into LLM context
- **Inline retry** — Feed parse/validation errors back to the LLM for self-correction (2 attempts)
- **Secret sanitizer** — 4-layer credential protection before persisting anything

## Domain adapters

Each domain implements one interface:

```typescript
interface DomainAdapter {
  readonly id: string;
  readonly name: string;
  extractKnowledge(): Promise<Knowledge[]>;
  execute(plan: ExecutionPlan): Promise<ExecutionResult>;
  validate(plan: ExecutionPlan): ValidationResult;
  queryExpansions?(): Record<string, string[]>;   // TF-IDF synonyms
  planNormalizers?(): PlanNormalizer[];            // Domain-specific LLM fixes
}
```

### Built-in domains

| Domain | Operations | Eval goals | Description |
|--------|-----------|------------|-------------|
| **echo** | 7 | 5 | Test domain — echoes params back, no external services |
| **browser** | 16 | 6 | Chrome automation via PinchTab/CDP |
| **wordpress** | 20+ | 6 | REST API with live endpoint discovery from `/wp-json/` |
| **n8n** | 17+ | 6 | Workflow composition + deploy via REST API |
| **wp-cli** | 25+ | 5 | WordPress via WP-CLI terminal commands with Shell Engine |
| **git** | 28 | 5 | Git version control via Shell Engine |

**Echo** — CRUD items, links, notifications. For testing the full pipeline without external dependencies.

**Browser** — Navigate, click, fill, type, screenshot, evaluate JS, and more. Connects to Chrome via PinchTab server.

**WordPress** — 20 built-in endpoints (posts, pages, categories, tags, media, users, comments, settings, WooCommerce). Live discovery connects to `/wp-json/` and extracts 1300+ endpoints. Plan normalizers handle `PATCH→POST`, taxonomy array wrapping, WooCommerce `[{id:N}]` format.

**n8n** — 17 built-in node types across 6 categories (triggers, HTTP, flow control, transforms, integrations, AI). Execution composes a complete n8n workflow JSON with BFS auto-layout and deploys it via the REST API — it doesn't execute steps sequentially.

**wp-cli** — 25 built-in WP-CLI operations (posts, taxonomy, users, plugins, themes, database, options, search-replace, cache, rewrite, WooCommerce). Executes `wp` commands via the Shell Engine with RBAC policy enforcement — no API keys needed, uses local server auth. Live discovery via `wp cli cmd-dump`. Admin commands auto-elevate. Ideal for DevOps, CI/CD, and local development.

**git** — 28 built-in operations across 9 categories (setup, staging, branch, remote, history, merge, stash, tag, undo). Executes `git` commands via the Shell Engine — the dev RBAC role blocks dangerous patterns like `git push --force` and `git reset --hard`. Command spec mapping converts typed params to proper flag styles (-m, --oneline, positional args). Plan normalizers fix LLM mistakes: bare operationIds, msg→message, branch→name, repo→url.

### Writing your own domain

Any CLI tool can become a domain adapter. The pattern is always the same:

1. **Define Knowledge** — describe what commands exist, with typed parameters
2. **Build commands** — convert ExecutionStep params into shell command strings
3. **Execute via Shell Engine** — RBAC policy, audit log, timeout, output limits for free
4. **Parse output** — turn stdout into structured data for downstream steps
5. **Add normalizers** — fix the mistakes LLMs make with your domain

#### Minimal example (API-based domain)

```typescript
import type { DomainAdapter } from 'ctt-shell';

export class MyAdapter implements DomainAdapter {
  readonly id = 'my-domain';
  readonly name = 'My Domain';

  async extractKnowledge() {
    return [/* Knowledge entities describing your operations */];
  }

  async execute(plan) {
    // Execute each step against your API
  }

  validate(plan) {
    // Check operationIds exist, deps are valid
  }

  queryExpansions() {
    return { 'user': ['account', 'member', 'person'] };
  }

  planNormalizers() {
    return [(plan, fixes) => { /* fix domain-specific issues */ }];
  }
}
```

#### Full example: Adding a CLI tool (e.g., `docker`, `kubectl`, `terraform`)

This is how wp-cli and git adapters work. Use this as a template for any CLI tool.

**Step 1 — Create the adapter file** (`domains/my-cli/adapter.ts`):

```typescript
import type { DomainAdapter, PlanNormalizer } from '../../src/domain/adapter.js';
import type {
  Knowledge, ExecutionPlan, ExecutionResult, ExecutionStep,
  ValidationResult, StepResult,
} from '../../src/types/entities.js';
import { createExecutor } from '../../src/shell/executor.js';
import { AuditLog } from '../../src/shell/audit.js';
import type { ShellRole } from '../../src/shell/policy.js';
import { join } from 'node:path';

export class MyCliAdapter implements DomainAdapter {
  readonly id = 'my-cli';          // Used in store paths and --domain flag
  readonly name = 'My Tool (CLI)'; // Display name
  private executor;

  constructor(config?: { role?: ShellRole; cwd?: string }) {
    const audit = new AuditLog(join(process.cwd(), '.ctt-shell', 'logs'));
    this.executor = createExecutor(
      config?.role ?? 'dev',
      config?.cwd ?? process.cwd(),
      audit,
    );
  }

  // ── 1. Define what operations exist ──────────────────────────────────────

  async extractKnowledge(): Promise<Knowledge[]> {
    return MY_KNOWLEDGE;
  }

  // ── 2. Execute plans via Shell Engine ────────────────────────────────────

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    const start = Date.now();
    const outputs = new Map<string, unknown>();
    const stepResults: StepResult[] = [];

    for (const step of plan.steps) {
      const stepStart = Date.now();
      const cmd = this.buildCommand(step, outputs);
      const result = this.executor.exec(cmd);

      if (!result.executed || result.exitCode !== 0) {
        stepResults.push({
          stepId: step.stepId, operationId: step.operationId,
          success: false,
          error: result.denyReason || result.stderr || `Exit code: ${result.exitCode}`,
          durationMs: Date.now() - stepStart,
        });
        continue;
      }

      const response = this.parseOutput(result.stdout, step);
      if (step.outputRef) outputs.set(step.outputRef, response);

      stepResults.push({
        stepId: step.stepId, operationId: step.operationId,
        success: true, response, durationMs: Date.now() - stepStart,
      });
    }

    const success = stepResults.every(s => s.success);
    return {
      success, goal: plan.goal, domainId: this.id,
      steps: stepResults, totalDurationMs: Date.now() - start,
      error: success ? undefined : stepResults.find(s => !s.success)?.error,
    };
  }

  // ── 3. Build shell commands from step params ─────────────────────────────

  private buildCommand(step: ExecutionStep, outputs: Map<string, unknown>): string {
    // Convert operationId to command: "mycli.resource.list" → "mycli resource list"
    const subcommand = step.operationId.replace(/^mycli\./, '').replace(/\./g, ' ');
    const parts = ['mycli', subcommand];

    for (const [key, value] of Object.entries(step.params)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'boolean' && value) {
        parts.push(`--${key}`);
      } else if (key === '_positional') {
        parts.push(String(value));           // bare positional arg
      } else {
        parts.push(`--${key}=${String(value)}`);
      }
    }
    return parts.join(' ');
  }

  // ── 4. Parse stdout into structured data ─────────────────────────────────

  private parseOutput(stdout: string, step: ExecutionStep): unknown {
    try { return JSON.parse(stdout.trim()); }
    catch { return { output: stdout.trim() }; }
  }

  // ── 5. Validate plans before execution ───────────────────────────────────

  validate(plan: ExecutionPlan): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const knownOps = new Set(MY_KNOWLEDGE.map(k => k.operationId));

    for (const step of plan.steps) {
      if (!step.operationId.startsWith('mycli.')) {
        errors.push(`Step ${step.stepId}: must start with "mycli."`);
      } else if (!knownOps.has(step.operationId)) {
        warnings.push(`Step ${step.stepId}: unknown operation "${step.operationId}"`);
      }
      // Validate dependencies
      if (step.dependsOn) {
        const ids = new Set(plan.steps.map(s => s.stepId));
        for (const dep of step.dependsOn) {
          if (!ids.has(dep)) errors.push(`Step ${step.stepId} depends on non-existent ${dep}`);
        }
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  // ── 6. Help TF-IDF find your operations ──────────────────────────────────

  queryExpansions(): Record<string, string[]> {
    return {
      'resource': ['item', 'object', 'entity'],
      'list':     ['show', 'get', 'display'],
      'create':   ['new', 'add', 'make'],
      'delete':   ['remove', 'destroy', 'rm'],
    };
  }

  // ── 7. Fix common LLM mistakes ──────────────────────────────────────────

  planNormalizers(): PlanNormalizer[] {
    return [
      // Add prefix if missing: "resource list" → "mycli.resource.list"
      (plan, fixes) => {
        for (const step of plan.steps) {
          if (!step.operationId.startsWith('mycli.')) {
            step.operationId = `mycli.${step.operationId.replace(/\s+/g, '.')}`;
            fixes.push('added mycli. prefix');
          }
        }
      },
      // Fix param names LLMs get wrong
      (plan, fixes) => {
        for (const step of plan.steps) {
          if (step.params['name'] && !step.params['_positional']) {
            step.params['_positional'] = step.params['name'];
            delete step.params['name'];
            fixes.push('moved name to positional arg');
          }
        }
      },
    ];
  }
}

// ── Knowledge definitions ──────────────────────────────────────────────────

const MY_KNOWLEDGE: Knowledge[] = [
  {
    id: 'mycli-resource-list', type: 'knowledge', domainId: 'my-cli',
    createdAt: '', updatedAt: '', tags: ['my-cli', 'resource', 'list'],
    operationId: 'mycli.resource.list',
    displayName: 'mycli resource list',
    description: 'List all resources',
    category: 'resource',
    parameters: [
      { name: 'format', type: 'string', description: 'Output format (json, table)', required: false },
    ],
  },
  // ... more Knowledge entities
];

// ── Eval goals ─────────────────────────────────────────────────────────────

export const MYCLI_EVAL_GOALS = [
  { goal: 'List all resources', domainId: 'my-cli', expectedOps: ['mycli.resource.list'], complexity: 'simple' as const },
];
```

**Step 2 — Create barrel export** (`domains/my-cli/index.ts`):

```typescript
export { MyCliAdapter, MYCLI_EVAL_GOALS } from './adapter.js';
```

**Step 3 — Register in CLI** (`src/cli/cli.ts`):

```typescript
import { MyCliAdapter, MYCLI_EVAL_GOALS } from '../../domains/my-cli/index.js';

// In createInfra():
domains.register(new MyCliAdapter());

// In goalsByDomain:
'my-cli': MYCLI_EVAL_GOALS,
```

**Step 4 — Register in MCP server** (`src/mcp/server.ts`):

```typescript
import { MyCliAdapter } from '../../domains/my-cli/index.js';

// In createInfra():
domains.register(new MyCliAdapter());
```

**Step 5 — Add binary to Shell Engine policy** (`src/shell/policy.ts`):

If your CLI binary isn't already in the dev role's `allowedCommands`, add it:

```typescript
// In the dev policy's allowedCommands array:
'mycli',
```

Currently allowed: `ls cat head tail wc find grep which echo pwd whoami date env printenv git node npm npx tsc tsx mkdir touch cp mv curl wget tar unzip gzip diff sort uniq cut tr sed awk jq wp`

**Step 6 — Write tests, compile, verify**:

```bash
npm run build && npm test
```

#### Design decisions for CLI adapters

| Decision | Recommendation | Example |
|----------|---------------|---------|
| **operationId format** | `<tool>.<resource>.<action>` | `docker.container.run`, `kubectl.pod.list` |
| **Positional args** | Use `_positional` param key | `{ _positional: "nginx:latest" }` |
| **Output parsing** | Try JSON first, fall back to text | `--format=json`, `--output=json`, `-o json` |
| **Destructive commands** | Warn in validate(), let RBAC enforce | `docker.system.prune`, `kubectl.delete` |
| **Live discovery** | Parse `<tool> help` or similar | `docker info --format json`, `kubectl api-resources` |
| **Admin elevation** | Create one-off admin executor | See wp-cli adapter's ADMIN_COMMANDS pattern |

#### Checklist for new CLI adapters

- [ ] `domains/<tool>/adapter.ts` — Adapter class implementing DomainAdapter
- [ ] `domains/<tool>/index.ts` — Barrel exports
- [ ] Knowledge entities — At least 10-15 operations with typed parameters
- [ ] `buildCommand()` — Convert operationId + params to proper CLI syntax
- [ ] `parseOutput()` — Parse stdout into structured data (JSON preferred)
- [ ] `validate()` — Check operationId prefix, known ops, dependency refs
- [ ] `queryExpansions()` — 5-10 synonym mappings for TF-IDF search
- [ ] `planNormalizers()` — At least: prefix fix, param renaming
- [ ] Eval goals — 3-5 goals (simple, medium, complex)
- [ ] Register in `src/cli/cli.ts` (import, register, eval goals)
- [ ] Register in `src/mcp/server.ts` (import, register)
- [ ] Add binary to `src/shell/policy.ts` dev role if not already there
- [ ] Unit tests in `tests/unit/domain-adapters.test.ts`
- [ ] `npm run build && npm test`

## CLI commands

```bash
npm run build                                    # Compile TypeScript
npm test                                         # Run 167 unit tests

node dist/src/cli/cli.js extract <domain>        # Extract Knowledge from domain
node dist/src/cli/cli.js search <query>          # TF-IDF search across all domains
node dist/src/cli/cli.js exec <goal>             # Autonomous: recall → plan → execute → learn
node dist/src/cli/cli.js eval                    # Evaluate all 33 goals across all domains
node dist/src/cli/cli.js eval --domain wordpress # Evaluate single domain
node dist/src/cli/cli.js eval --models "cf:@cf/meta/llama-3.2-3b-instruct"
node dist/src/cli/cli.js status                  # Store statistics
node dist/src/cli/cli.js domain list             # List registered domains
node dist/src/cli/cli.js context add info.md     # Load business context from file
node dist/src/cli/cli.js context add --text "…"  # Add inline context text
node dist/src/cli/cli.js context list            # List loaded context entries
node dist/src/cli/cli.js context clear           # Remove all context entries
node dist/src/cli/cli.js mcp                     # Start MCP server (stdio)
```

## Environment variables

### LLM providers (pick one)

| Variable | Provider |
|----------|----------|
| `CF_API_KEY` + `CF_ACCOUNT_ID` | Cloudflare Workers AI (free tier) |
| `ANTHROPIC_API_KEY` | Claude |
| `OPENAI_API_KEY` | OpenAI |
| `OLLAMA_MODEL` | Local Ollama (default: `qwen2.5:3b`) |

### Domain connections (optional)

| Variable | Domain |
|----------|--------|
| `WP_BASE_URL` | WordPress instance URL |
| `WP_USERNAME` + `WP_APP_PASSWORD` | WordPress auth |
| `N8N_BASE_URL` + `N8N_API_KEY` | n8n instance |
| `PINCHTAB_URL` | PinchTab server (default: `http://127.0.0.1:9867`) |

Config file alternative: `.ctt-shell/config.json`

## Project structure

```
src/
  types/          → Entity types (Knowledge, Skill, Memory, Profile) + ExecutionPlan
  storage/        → Content-addressable filesystem store (SHA-256 dedup)
  search/         → TF-IDF search with Porter stemming + injectable expansions
  guardrails/     → Response normalizer, plan normalizer, circuit breaker, sanitizer
  domain/         → DomainAdapter interface + DomainRegistry
  agent/          → Autonomous pipeline (recall→plan→normalize→validate→execute→learn)
  llm/            → LLM providers (Claude, OpenAI, Ollama, Cloudflare Workers AI)
  eval/           → Model evaluation framework + inline retry
  shell/          → Shell Engine (parser, executor, RBAC policy, audit log)
  context/        → Context Loader (user-provided business knowledge ingestion)
  mcp/            → MCP server (8 tools, stdio JSON-RPC 2.0)
  cli/            → CLI entry point
domains/
  echo/           → Test domain (7 operations, 5 eval goals)
  browser/        → Chrome CDP via PinchTab (16 ops, 6 goals)
  wordpress/      → WordPress REST API (20+ endpoints, 6 goals)
  n8n/            → n8n workflow automation (17+ node types, 6 goals)
  wp-cli/         → WordPress via WP-CLI terminal (25+ ops, 5 goals)
  git/            → Git version control (28 ops, 5 goals)
tests/
  unit/           → 167 unit tests (store, search, normalizers, adapters, MCP, shell, context)
```

## MCP server

ctt-shell exposes its full pipeline as 8 MCP tools over stdio:

| Tool | Description |
|------|-------------|
| `ctt_search` | TF-IDF search across all domains |
| `ctt_execute` | Full autonomous pipeline (recall → plan → execute → learn) |
| `ctt_extract` | Extract Knowledge from a domain |
| `ctt_list_domains` | List registered domains with operation counts |
| `ctt_store_stats` | Store statistics |
| `ctt_recall` | Build CTT context for a goal (without executing) |
| `ctt_shell` | Execute shell commands with RBAC policy enforcement |
| `ctt_context` | Manage user-provided business context (add, list, remove, load) |

### Claude Desktop integration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ctt-shell": {
      "command": "node",
      "args": ["dist/src/cli/cli.js", "mcp"],
      "cwd": "/path/to/ctt-shell",
      "env": {
        "CF_API_KEY": "your-key",
        "CF_ACCOUNT_ID": "your-account"
      }
    }
  }
}
```

This lets Claude (or any MCP client) search operations, compose plans, execute workflows, and learn from results across all 6 domains.

## Context loader (business knowledge)

Load domain-specific business context that enriches LLM prompts. Context entries are indexed by TF-IDF and appear in RECALL results alongside domain operations.

```bash
# Load a markdown file (splits by ## headers into separate searchable entries)
node dist/src/cli/cli.js context add docs/products.md

# Add inline text
node dist/src/cli/cli.js context add --text "Premium plan costs $99/month" --category pricing

# Load all files from a directory
node dist/src/cli/cli.js context load-dir .ctt-shell/context/

# List and manage
node dist/src/cli/cli.js context list
node dist/src/cli/cli.js context remove <id>
node dist/src/cli/cli.js context clear
```

Supported file types: `.md` (split by `##` headers), `.txt` (single entry), `.json` (structured bulk import).

Files placed in `.ctt-shell/context/` are auto-loaded on MCP server startup.

Context appears in LLM prompts under **"## Background Context"**, separate from domain operations:

```
## Background Context
### Company Info — Pricing
Basic plan $29/month, Premium $99/month...

## Available Operations
### Create Post (POST:/wp/v2/posts)
...
```

## Tests

```bash
npm run build && npm test
```

167 tests covering:
- **Store** (8) — CRUD, SHA-256 dedup, batch operations
- **TF-IDF search** (6) — matching, ranking, query expansion
- **Response normalizer** (12) — JSON extraction, truncation recovery, thinking tags
- **Plan normalizer** (11) — dependency fixing, orphan chaining, circular deps
- **Domain adapters** (67) — all 6 adapters: knowledge, validation, execution, normalizers
- **MCP server** (11) — protocol handshake, tool listing, all 8 tools, error handling
- **Shell engine** (34) — parser (10), policy/RBAC (13), executor (6), audit log (5)
- **Context loader** (18) — addText, loadFile (markdown/json/txt), loadDirectory, list/remove/clear, TF-IDF integration

## How CTT works

Traditional approach: train a bigger model to handle complex tasks.

CTT approach: give a small model the right context at inference time:

1. **Knowledge entities** describe every available operation with typed parameters
2. **Skill patterns** show proven step sequences as few-shot examples
3. **Memory entities** warn about past failures ("don't use PATCH, use POST for WordPress")
4. **Guard rails** catch and fix the remaining mistakes automatically

The result: a 3B model with CTT context achieves 96% composition rate across 33 multi-domain goals. The same model without CTT context produces unparseable JSON most of the time.

## License

MIT — see [LICENSE](LICENSE) for details.

## Author

[MauricioPerera](https://github.com/MauricioPerera)
