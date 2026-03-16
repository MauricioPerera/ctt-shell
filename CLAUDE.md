# ctt-shell — Universal AI Agent Framework

## What is this
Framework TypeScript that combines three proven architectures:
- **Agent-Shell**: Controlled terminal for LLM agents (parser, executor, RBAC policy, audit log)
- **CTT Memory**: Entity-based persistent memory (Knowledge, Skills, Memories, Profiles) with content-addressable store
- **a2e Guard Rails**: Normalizers, circuit breaker, inline retry, few-shot learning — proven to make 3B models match 12B

The thesis: structured context at inference time substitutes for parameter count (Context-Time Training).

## Architecture (6 layers, bottom-up)
```
MCP Interface    → stdio | HTTP/SSE | CLI
Agent Layer      → Autonomous | Interactive | Eval Runner
Guard Rails      → Response Normalizer | Plan Normalizer | Circuit Breaker | Inline Retry | Sanitizer
Domain Layer     → DomainRegistry | DomainAdapter interface | Knowledge Resolver
CTT Memory       → Store (SHA-256) | Search (TF-IDF) | Skills Lifecycle
Shell Engine     → Parser | Executor | RBAC Policy (readonly/dev/admin) | Audit Log
```

## Project structure
```
src/
  types/          → Entity types (Knowledge, Skill, Memory, Profile) + ExecutionPlan
  storage/        → Content-addressable filesystem store (SHA-256 dedup)
  search/         → TF-IDF search with Porter stemming + injectable domain expansions
  guardrails/     → Response normalizer, plan normalizer, circuit breaker, sanitizer
  domain/         → DomainAdapter interface + DomainRegistry
  agent/          → Autonomous pipeline (recall→plan→normalize→validate→execute→learn)
               + recall (TF-IDF context builder) + learn (skill lifecycle)
  llm/            → LLM providers (Claude, OpenAI, Ollama, Cloudflare Workers AI)
  eval/           → Model evaluation framework + inline retry for small models
  shell/          → Shell Engine (parser, executor, RBAC policy, audit log)
  mcp/            → MCP server (7 tools, stdio JSON-RPC 2.0)
  cli/            → CLI entry point
domains/
  echo/           → Test domain adapter (7 operations, 5 eval goals)
  browser/        → Chrome CDP via PinchTab (16 operations, 6 eval goals)
  wordpress/      → WordPress REST API (20 built-in + live discovery, 6 eval goals)
  n8n/            → n8n workflow automation (17 built-in + live extraction, 6 eval goals)
tests/            → Unit tests
contracts/        → Specification contracts
```

## Commands
```bash
npm run build                                    # Compile TypeScript
npm test                                         # Run 117 unit tests
node dist/src/cli/cli.js search <query>          # TF-IDF search across all domains
node dist/src/cli/cli.js exec <goal>             # Autonomous pipeline
node dist/src/cli/cli.js eval                    # Evaluate all domains
node dist/src/cli/cli.js eval --domain browser   # Evaluate single domain
node dist/src/cli/cli.js eval --models "cf:@cf/meta/llama-3.2-3b-instruct"
node dist/src/cli/cli.js extract <domain>        # Extract Knowledge from domain
node dist/src/cli/cli.js status                  # Store stats
node dist/src/cli/cli.js domain list             # List registered domains
node dist/src/cli/cli.js mcp                     # Start MCP server (stdio)
```

## Environment variables
- `ANTHROPIC_API_KEY` — for Claude LLM provider
- `OPENAI_API_KEY` — for OpenAI LLM provider
- `OLLAMA_MODEL` — for local Ollama (default: qwen2.5:3b)
- `CF_API_KEY` — for Cloudflare Workers AI
- `CF_ACCOUNT_ID` — for Cloudflare Workers AI
- `WP_BASE_URL` — WordPress instance URL (for wordpress domain)
- `WP_USERNAME` — WordPress username (for wordpress domain)
- `WP_APP_PASSWORD` — WordPress Application Password (for wordpress domain)
- `N8N_BASE_URL` — n8n instance URL (for n8n domain)
- `N8N_API_KEY` — n8n API key (for n8n domain)
- `PINCHTAB_URL` — PinchTab server URL (for browser domain, default: http://127.0.0.1:9867)

## Config file
`.ctt-shell/config.json` — alternative to env vars. Supports: llmProvider, cfApiKey, cfAccountId, cfModel, cfGateway, ollamaModel

## Entity types (CTT mapping)
| Entity | CTT Role | Description |
|--------|----------|-------------|
| Knowledge | Definitions | Domain operation schemas (endpoints, params, I/O) |
| Skill | Patterns | Proven execution sequences with lifecycle (experimental→proven→deprecated) |
| Memory | Learning | Errors, fixes, optimizations from past executions |
| Profile | Config | Connection configs to external services |

## Domain adapters
Each domain implements the `DomainAdapter` interface:
```typescript
interface DomainAdapter {
  readonly id: string;
  readonly name: string;
  extractKnowledge(): Promise<Knowledge[]>;
  execute(plan: ExecutionPlan): Promise<ExecutionResult>;
  validate(plan: ExecutionPlan): ValidationResult;
  queryExpansions?(): Record<string, string[]>;    // domain-specific synonyms for TF-IDF
  planNormalizers?(): PlanNormalizer[];             // domain-specific LLM output fixes
}
```

### Echo (test domain)
- 7 operations: CRUD items, links, notifications
- Execution echoes params back — for testing pipeline without external services
- `operationId` format: `echo.items.create`, `echo.notify.send`

### Browser (PinchTab/Chrome CDP)
- 16 operations: navigate, click, fill, type, find, snapshot, screenshot, evaluate, press, scroll, select, text, wait, back, forward, reload
- Requires PinchTab server running on localhost:9867
- `operationId` format: `browser.navigate`, `browser.click`
- Plan normalizer: fixes shorthand operationIds, navigate param naming
- Query expansions: browse→navigate/open/visit, click→press/tap/select, fill→type/input/enter

### WordPress (REST API)
- 20 built-in endpoints (posts, pages, categories, tags, media, users, comments, settings, WooCommerce)
- Live discovery: connects to `/wp-json/` to discover 1300+ endpoints dynamically
- `operationId` format: `METHOD:/path` e.g. `POST:/wp/v2/posts`
- Plan normalizers: PATCH/PUT→POST, taxonomy array wrapping, WC `[{id:N}]` format, trailing suffix removal
- Handles `term_exists` idempotency errors (recovers existing ID)
- Query expansions: post→article/blog/content, category→taxonomy/term, woocommerce→shop/ecommerce

### n8n (Workflow Automation)
- 17 built-in node types (triggers, HTTP, flow control, transforms, integrations, AI)
- Live extraction: connects to n8n instance for actual node type schemas
- `operationId` format: n8n node type e.g. `n8n-nodes-base.webhook`
- Execution = compose workflow JSON + deploy via REST API (not sequential step execution)
- Includes BFS auto-layout algorithm for node positioning
- Plan normalizer: fixes shorthand node types, adds `n8n-` prefix
- Query expansions: email→gmail/smtp/imap, chat→slack/discord/telegram, schedule→cron/interval

## Key pipeline (Autonomous Agent)
1. RECALL — TF-IDF search finds relevant Knowledge + Skills + Memories
2. PLAN — LLM generates ExecutionPlan JSON with CTT context (few-shot + anti-patterns)
3. NORMALIZE — Response normalizer (JSON extraction) + Plan normalizer (structural fixes)
4. VALIDATE — DomainAdapter.validate()
5. EXECUTE — DomainAdapter.execute()
6. LEARN — Success→save Skill (experimental). Failure→save Memory + update Circuit Breaker

## Guard rails (proven in n8n-a2e + wp-a2e)
- **Response normalizer**: strip thinking tags, extract JSON from code fences (including unclosed), fix trailing commas, auto-close truncated JSON to last complete object
- **Plan normalizer**: fix out-of-bounds connections, self-loops, orphans, type coercion, circular dep breaking
- **Circuit breaker**: block operations after N consecutive failures, inject anti-patterns into LLM context
- **Inline retry**: feed execution errors back to LLM for self-correction (2 attempts for 3B models)
- **Secret sanitizer**: 4-layer credential protection before persisting

## Eval results (cross-domain, 23 goals)
```
Model                                 JSON%   Plan%   Comp%   Exec%   Steps   Latency
-------------------------------------------------------------------------------------
@cf/meta/llama-3.2-3b-instruct          96%     96%     96%      0%     2.0    1545ms
@cf/google/gemma-3-12b-it              100%    100%    100%      0%     2.2    4156ms
```

## Shell Engine (src/shell/)
Controlled command execution for LLM agents with RBAC, audit, and sandboxing.

### Components
- **Parser** — Tokenizes commands, handles quotes, pipes, env vars, redirects
- **Policy (RBAC)** — 3 built-in roles: readonly, dev, admin. Each defines allowed commands, denied patterns, path restrictions, timeouts
- **Executor** — Runs commands via child_process with policy enforcement, timeout, output limits
- **Audit** — Immutable JSONL log of all executions (allowed + denied) with timing and output previews

### Roles
- **readonly**: ls, cat, grep, git status/log/diff — blocks rm, mv, npm, curl
- **dev**: git, node, npm, curl, mkdir, cp, mv, sed, awk, jq — blocks sudo, rm -rf /, git push --force, npm publish
- **admin**: all commands — still blocks rm -rf /, fork bombs, dd to devices

### Audit log location
`.ctt-shell/logs/shell-audit.jsonl` — JSONL format, one entry per line

## MCP Server (src/mcp/)
Exposes CTT pipeline + shell as MCP tools over stdio (JSON-RPC 2.0, protocol version 2024-11-05).

### Tools
- **ctt_search** — TF-IDF search across all domains (query, limit)
- **ctt_execute** — Full autonomous pipeline: recall→plan→normalize→validate→execute→learn (goal, domain?)
- **ctt_extract** — Extract Knowledge from a domain (domain)
- **ctt_list_domains** — List registered domains with operation counts
- **ctt_store_stats** — Store statistics (knowledge/skill/memory/profile counts)
- **ctt_recall** — Build CTT context for a goal without executing (goal, compact?)
- **ctt_shell** — Execute shell commands with RBAC policy (command, role?, cwd?, validate_only?)

### Usage with Claude Desktop / claude_desktop_config.json
```json
{
  "mcpServers": {
    "ctt-shell": {
      "command": "node",
      "args": ["dist/src/cli/cli.js", "mcp"],
      "cwd": "/path/to/ctt-shell",
      "env": {
        "CF_API_KEY": "...",
        "CF_ACCOUNT_ID": "..."
      }
    }
  }
}
```

### Content-Length framing
Messages use `Content-Length: N\r\n\r\n{json}` framing per MCP spec. Logs go to stderr.

## Store location
`.ctt-shell/store/` — Contains knowledge/, skill/, memory/, profile/ per domain

## Zero runtime dependencies
Only Node.js built-ins: crypto, fs, path, http, child_process, readline. TypeScript for compilation only.
