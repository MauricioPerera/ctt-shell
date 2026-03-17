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
  search/         → TF-IDF search with Porter stemming, incremental indexing, injectable domain expansions
  guardrails/     → Response normalizer, plan normalizer, circuit breaker, sanitizer
  domain/         → DomainAdapter interface + DomainRegistry
  agent/          → Autonomous pipeline (recall→plan→normalize→validate→execute→learn)
               + recall (TF-IDF context builder) + learn (skill lifecycle) + enrich (memory enrichment)
  llm/            → LLM providers (Claude, OpenAI, Ollama, Cloudflare Workers AI, llama.cpp/llamafile)
  eval/           → Model evaluation framework + inline retry + benchmarks + persistent reports
  shell/          → Shell Engine (parser, executor, RBAC policy, audit log)
  context/        → Context Loader (user-provided business knowledge ingestion)
  mcp/            → MCP server (8 tools, stdio JSON-RPC 2.0)
  cli/            → CLI entry point
domains/
  echo/           → Test domain adapter (7 operations, 5 eval goals)
  browser/        → Chrome CDP via PinchTab (16 operations, 6 eval goals)
  wordpress/      → WordPress REST API (20 built-in + live discovery, 6 eval goals)
  n8n/            → n8n workflow automation (17 built-in + live extraction, 6 eval goals)
  wp-cli/         → WordPress via WP-CLI terminal commands (25 built-in + live discovery, 5 eval goals)
  git/            → Git via terminal commands (28 built-in operations, 5 eval goals)
tests/            → Unit tests
contracts/        → Specification contracts
```

## Commands
```bash
npm run build                                    # Compile TypeScript
npm test                                         # Run 222 unit tests
node dist/src/cli/cli.js search <query>          # TF-IDF search across all domains
node dist/src/cli/cli.js exec <goal>             # Autonomous pipeline
node dist/src/cli/cli.js eval                    # Evaluate all domains
node dist/src/cli/cli.js eval --domain browser   # Evaluate single domain
node dist/src/cli/cli.js eval --models "cf:@cf/meta/llama-3.2-3b-instruct"
node dist/src/cli/cli.js eval --exec             # Enable execution testing (Exec% > 0)
node dist/src/cli/cli.js eval --verbose          # Per-goal detailed output
node dist/src/cli/cli.js eval --baseline <path>  # Compare vs saved baseline report
node dist/src/cli/cli.js extract <domain>        # Extract Knowledge from domain
node dist/src/cli/cli.js status                  # Store stats
node dist/src/cli/cli.js domain list             # List registered domains
node dist/src/cli/cli.js context add file.md     # Load business context from file
node dist/src/cli/cli.js context add --text "…"  # Add inline context text
node dist/src/cli/cli.js context list            # List loaded context entries
node dist/src/cli/cli.js context remove <id>     # Remove a context entry
node dist/src/cli/cli.js context clear           # Remove all context entries
node dist/src/cli/cli.js context load-dir [dir]  # Load all files from directory
node dist/src/cli/cli.js mcp                     # Start MCP server (stdio)
node dist/src/cli/cli.js benchmark               # Run performance benchmarks
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
- `LLAMACPP_PORT` — llama.cpp/llamafile server port (default: 8080)

## Config file
`.ctt-shell/config.json` — alternative to env vars. Supports: llmProvider, cfApiKey, cfAccountId, cfModel, cfGateway, ollamaModel, llamacppModel, llamacppBaseUrl

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

### Adding a new CLI adapter (checklist)
1. Create `domains/<tool>/adapter.ts` — implement DomainAdapter using Shell Engine
2. Create `domains/<tool>/index.ts` — barrel exports
3. Define Knowledge entities (operationId format: `<tool>.<resource>.<action>`)
4. Implement `buildCommand()` — convert step params to CLI command string
5. Implement `parseOutput()` — parse stdout (JSON preferred, text fallback)
6. Add `queryExpansions()` (5-10 synonym mappings) and `planNormalizers()` (prefix fix, param rename)
7. Add eval goals (3-5: simple, medium, complex)
8. Register in `src/cli/cli.ts` (import + register + eval goals)
9. Register in `src/mcp/server.ts` (import + register)
10. Add binary to `src/shell/policy.ts` dev allowedCommands if not already there
11. Add tests to `tests/unit/domain-adapters.test.ts`
12. `npm run build && npm test`
See README.md for full template with code examples.

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

### WP-CLI (WordPress via Terminal)
- 25 built-in operations (posts, taxonomy, users, plugins, themes, database, options, search-replace, cache, rewrite, WooCommerce)
- Live discovery via `wp cli cmd-dump --format=json`
- `operationId` format: `wp.<group>.<subcommand>` e.g. `wp.post.create`, `wp.plugin.install`
- Executes wp commands via Shell Engine with RBAC policy enforcement
- Admin commands (plugin install, db export, etc.) auto-elevate to admin role
- `--porcelain` for create operations, `--format=json` for list/get
- 3 plan normalizers: shorthand fix (spaces/hyphens→dots), param renaming (title→post_title, name→_positional)
- Query expansions: post→article/blog/content, plugin→extension/addon, database→db/sql/mysql

### Git (CLI)
- 28 built-in operations across 9 categories (setup, staging, branch, remote, history, merge, stash, tag, undo)
- `operationId` format: `git.<command>` or `git.<group>.<subcommand>` e.g. `git.commit`, `git.branch.create`
- Executes git commands via Shell Engine with RBAC policy enforcement
- Dev role blocks dangerous patterns (`git push --force`, `git reset --hard`)
- Destructive ops (reset, rebase, clean, branch.delete) generate validation warnings
- Command spec mapping: each operationId maps to typed param handlers (flag, short-flag, value, positional)
- 3 plan normalizers: prefix fix, space-to-dot, param renaming (msg→message, branch→name, repo→url, file→files)
- Query expansions: commit→save/snapshot, branch→fork/feature, merge→combine/integrate, push→upload/deploy

## Key pipeline (Autonomous Agent)
1. RECALL — TF-IDF search finds relevant Knowledge + Skills + Memories
2. PLAN — LLM generates ExecutionPlan JSON with CTT context (few-shot + anti-patterns)
3. NORMALIZE — Response normalizer (JSON extraction) + Plan normalizer (structural fixes)
4. VALIDATE — DomainAdapter.validate()
5. EXECUTE — DomainAdapter.execute()
6. LEARN — Success→save Skill (experimental) + incremental index. Failure→save Memory + update Circuit Breaker + incremental index
7. ENRICH (optional) — If `enrichLlm` configured, small local LLM classifies error memories (category, tags, severity, fix suggestion) via 3-4 parallel single-task prompts

### Search indexing strategy
- **Full rebuild** (`search.index()`): used once at cold startup
- **Incremental** (`search.addToIndex()`): used after knowledge extraction, learning, context loading. ~115x faster than full rebuild.
- **Query expansions**: domain synonyms are pre-stemmed at registration time (not per-search)

## Guard rails (proven in n8n-a2e + wp-a2e)
- **Response normalizer**: strip thinking tags, extract JSON from code fences (including unclosed), fix trailing commas, auto-close truncated JSON to last complete object. Uses array-based string building and incremental bracket counting for performance.
- **Plan normalizer**: fix out-of-bounds connections, self-loops, orphans, type coercion. Single-pass DFS cycle detection with 3-state coloring (O(n) vs previous O(n²)). Uses Map for O(1) step lookups.
- **Circuit breaker**: block operations after N consecutive failures (default threshold: 3), inject anti-patterns into LLM context. Tracks error reasons and resolutions per target. Lazy-loads from stored Memory entities.
- **Inline retry**: feed execution errors back to LLM for self-correction (2 attempts for 3B models)
- **Secret sanitizer**: 4-layer credential protection before persisting (known secrets map, URL auth params, JSON credential fields, known prefixes like sk-, ghp_, Bearer, JWT)

## Memory Enrichment (src/agent/enrich.ts)
Optional post-processing that uses a small local LLM to classify and tag error memories.

### How it works
- After `learnFromError()` saves a raw Memory, the enrichment pipeline runs 3-4 **parallel** single-task prompts
- Each prompt is ultra-short (~50 tokens) designed for sub-1B models
- **classify**: error→category (auth, timeout, validation, not_found, etc.)
- **tags**: extract 3-5 keyword tags for better TF-IDF recall
- **severity**: blocking, recoverable, or warning
- **suggestFix** (optional): one-line fix suggestion

### Configuration
Set `enrichLlm` in `AutonomousAgentConfig` to enable. Uses a separate LLM instance (can be different model/provider than the plan LLM).
```typescript
const agent = new AutonomousAgent({
  store, search, domains,
  llm: mainLlm,            // for plan generation
  enrichLlm: localLlm,     // for memory enrichment (optional)
});
```

### Model recommendations
- **gemma3:270m** (Ollama): best quality/speed ratio for enrichment (~5s per memory, follows format)
- **SmolLM2-135M**: too small, does not follow instructions reliably (IFEval 38%)

## LLM Providers (src/llm/provider.ts)
5 providers: Claude, OpenAI, Ollama, Cloudflare Workers AI, llama.cpp/llamafile.

### llama.cpp / llamafile provider
For running models locally via llama-server or llamafile with OpenAI-compatible API.
```bash
# Start llamafile server
llamafile.exe --server -m model.gguf --nobrowser --port 8080 -ngl 999
# Use in eval
LLAMACPP_PORT=8080 node dist/src/cli/cli.js eval --exec --models "llamacpp:model-name"
```
Short alias in --models: `lc:model-name` expands to `llamacpp:model-name`.

## Eval Framework (src/eval/)
Measures LLM plan generation quality across domains with persistent reporting and regression tracking.

### Metrics
- **JSON%** — valid JSON extracted from LLM response
- **Plan%** — valid ExecutionPlan structure (goal + steps array)
- **Comp%** — all steps have operationId and params (composition quality)
- **Exec%** — execution/validation passed (requires `--exec` flag)
- **Steps** — average step count per goal
- **Latency** — average time per goal (LLM + normalization)

### Features
- **Persistent reports**: auto-saved to `.ctt-shell/eval/` as timestamped JSON
- **Regression tracking**: `--baseline <path>` compares vs saved report, flags >5pp drops
- **Execution testing**: `--exec` runs echo domain plans through full execution, validates others
- **Verbose output**: `--verbose` shows per-goal raw response, fixes applied, errors
- **Inline retry**: small models (1B/3B) get 2 attempts with error feedback

### Report storage
`.ctt-shell/eval/` — JSON files named `{timestamp}.json`, loadable as baselines

### Eval results (cross-domain, 33 goals, --exec)
```
Model                                 JSON%   Plan%   Comp%   Exec%   Steps   Latency
-------------------------------------------------------------------------------------
@cf/qwen/qwen3-30b-a3b-fp8             100%    100%    100%    100%     2.1    3188ms
@cf/meta/llama-3.1-8b-instruct-fast     97%     97%     97%     97%     2.0    2000ms
@cf/meta/llama-3.2-1b-instruct         100%    100%    100%    100%     2.5    2269ms
@cf/meta/llama-3.2-3b-instruct          94%     94%     94%     94%     2.1    1626ms
@cf/google/gemma-3-12b-it               97%     97%     97%     97%     2.0    6680ms
@cf/ibm-granite/granite-4.0-h-micro      91%     91%     91%     91%     2.0    6974ms
@cf/zai-org/glm-4.7-flash               97%     97%     97%     97%     2.0    9119ms
ollama:gemma3:270m (local)               91%     88%     88%     88%     1.8   78158ms
llamafile:gemma3:270m (local)            91%     85%     85%     85%     1.9   89083ms
```
Qwen3 30B A3B (MoE, 3B active params) and Llama 3.2 1B achieve 100% across all metrics. The 1B Llama remains fastest (1626-2269ms range). CTT context compensates for parameter count — even 1B models match 30B. Gemma3 270M running 100% locally via Ollama/llamafile achieves 85-88% execution with only 268M parameters (Q8_0) — the smallest model tested, proving CTT works even at sub-1B scale without any cloud API dependency.

## Benchmark Harness (src/eval/benchmark.ts)
Performance measurement for core operations. Run with `ctt-shell benchmark`.

Benchmarks: search.index, search.addToIndex, search.search, normalizeResponse, normalizePlan, store.list.
Output: min/avg/p95/max latency per operation.

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
- **ctt_context** — Manage user-provided business context (add_text, add_file, list, remove, clear, load_dir)

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

## Context Loader (src/context/)
User-provided business knowledge that enriches LLM prompts with domain-specific background.

### How it works
- Files (.md, .txt, .json) or inline text → Knowledge entities with `domainId: 'context'`
- Markdown files split by `##` headers → each section is independently searchable via TF-IDF
- JSON files support bulk import (array of `{title, content, category?, tags?}`)
- Context entities appear in RECALL results under "## Background Context" (separate from domain operations)
- Auto-loaded from `.ctt-shell/context/` directory on MCP server startup

### File format examples
```markdown
# Company Info              ← becomes document title
## Pricing                  ← separate Knowledge entity: "Company Info — Pricing"
Basic plan $29/month...
## Support                  ← separate Knowledge entity: "Company Info — Support"
24/7 email support...
```

```json
[
  {"title": "Return Policy", "content": "30-day returns...", "category": "policy"},
  {"title": "Pricing", "content": "Basic $29, Premium $99...", "category": "pricing"}
]
```

### Context directory
Place files in `.ctt-shell/context/` for auto-loading, or load manually via CLI/MCP.

## Store location
`.ctt-shell/store/` — Contains knowledge/, skill/, memory/, profile/ per domain

## Test suite (232 tests, 25 suites)
```
tests/unit/
  domain-adapters.test.ts    → 64 tests: knowledge extraction, validation, normalization for all 6 domains
  shell.test.ts              → 34 tests: parser, executor, RBAC policy, audit log
  context-loader.test.ts     → 18 tests: addText, loadFile, markdown splitting, directory loading
  normalize-response.test.ts → 15 tests: JSON extraction, thinking tags, trailing commas, auto-close
  normalize-plan.test.ts     → 11 tests: step IDs, dependencies, cycles, orphans
  mcp-server.test.ts         → 11 tests: MCP tool handling
  store.test.ts              →  8 tests: content-addressable store CRUD
  tfidf.test.ts              →  6 tests: indexing, search, query expansion
  sanitize.test.ts           → 22 tests: 4-layer sanitization, round-trip, nested objects
  agent.test.ts              → 21 tests: recall, contextToPrompt, learnSkill, learnFromError, learnFix
  circuit-breaker.test.ts    → 12 tests: threshold, reset, antipatterns, lazy load, extractHost
  enrich.test.ts             → 10 tests: enrichMemory, applyEnrichment, enrichMemories batch, LLM error handling
```

## Zero runtime dependencies
Only Node.js built-ins: crypto, fs, path, http, child_process, readline. TypeScript for compilation only.
