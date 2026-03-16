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

23 goals across 4 domains — **zero runtime dependencies**, just Node.js built-ins:

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
Shell Engine     → Command Registry | Parser | Executor | Pipelines | RBAC | Audit
```

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

**Echo** — CRUD items, links, notifications. For testing the full pipeline without external dependencies.

**Browser** — Navigate, click, fill, type, screenshot, evaluate JS, and more. Connects to Chrome via PinchTab server.

**WordPress** — 20 built-in endpoints (posts, pages, categories, tags, media, users, comments, settings, WooCommerce). Live discovery connects to `/wp-json/` and extracts 1300+ endpoints. Plan normalizers handle `PATCH→POST`, taxonomy array wrapping, WooCommerce `[{id:N}]` format.

**n8n** — 17 built-in node types across 6 categories (triggers, HTTP, flow control, transforms, integrations, AI). Execution composes a complete n8n workflow JSON with BFS auto-layout and deploys it via the REST API — it doesn't execute steps sequentially.

### Writing your own domain

```typescript
import type { DomainAdapter } from 'ctt-shell';

export class MyAdapter implements DomainAdapter {
  readonly id = 'my-domain';
  readonly name = 'My Domain';

  async extractKnowledge() {
    return [/* Knowledge entities describing your API operations */];
  }

  async execute(plan) {
    // Execute each step against your API
  }

  validate(plan) {
    // Check operationIds exist, deps are valid
  }

  // Optional: help TF-IDF find your operations
  queryExpansions() {
    return { 'user': ['account', 'member', 'person'] };
  }

  // Optional: fix common LLM mistakes for your domain
  planNormalizers() {
    return [(plan, fixes) => { /* fix domain-specific issues */ }];
  }
}
```

## CLI commands

```bash
npm run build                                    # Compile TypeScript
npm test                                         # Run 72 unit tests

node dist/src/cli/cli.js extract <domain>        # Extract Knowledge from domain
node dist/src/cli/cli.js search <query>          # TF-IDF search across all domains
node dist/src/cli/cli.js exec <goal>             # Autonomous: recall → plan → execute → learn
node dist/src/cli/cli.js eval                    # Evaluate all 23 goals across all domains
node dist/src/cli/cli.js eval --domain wordpress # Evaluate single domain
node dist/src/cli/cli.js eval --models "cf:@cf/meta/llama-3.2-3b-instruct"
node dist/src/cli/cli.js status                  # Store statistics
node dist/src/cli/cli.js domain list             # List registered domains
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
  cli/            → CLI entry point
domains/
  echo/           → Test domain (7 operations, 5 eval goals)
  browser/        → Chrome CDP via PinchTab (16 ops, 6 goals)
  wordpress/      → WordPress REST API (20+ endpoints, 6 goals)
  n8n/            → n8n workflow automation (17+ node types, 6 goals)
tests/
  unit/           → 72 unit tests (store, search, normalizers, adapters)
```

## Tests

```bash
npm run build && npm test
```

72 tests covering:
- **Store** (8) — CRUD, SHA-256 dedup, batch operations
- **TF-IDF search** (6) — matching, ranking, query expansion
- **Response normalizer** (12) — JSON extraction, truncation recovery, thinking tags
- **Plan normalizer** (11) — dependency fixing, orphan chaining, circular deps
- **Domain adapters** (35) — all 4 adapters: knowledge, validation, execution, normalizers

## How CTT works

Traditional approach: train a bigger model to handle complex tasks.

CTT approach: give a small model the right context at inference time:

1. **Knowledge entities** describe every available operation with typed parameters
2. **Skill patterns** show proven step sequences as few-shot examples
3. **Memory entities** warn about past failures ("don't use PATCH, use POST for WordPress")
4. **Guard rails** catch and fix the remaining mistakes automatically

The result: a 3B model with CTT context achieves 96% composition rate across 23 multi-domain goals. The same model without CTT context produces unparseable JSON most of the time.

## License

MIT — see [LICENSE](LICENSE) for details.

## Author

[MauricioPerera](https://github.com/MauricioPerera)
