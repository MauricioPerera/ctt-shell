# ctt-shell — Universal AI Agent Framework

## What is this
Framework TypeScript that combines three proven architectures:
- **Agent-Shell**: 2-tool MCP execution engine (registry, parser, pipelines, RBAC, audit)
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
Shell Engine     → Command Registry | Parser (AST) | Executor | Pipelines | RBAC | Audit
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
  llm/            → LLM providers (Claude, OpenAI, Ollama, Cloudflare Workers AI)
  eval/           → Model evaluation framework + A/B feedback testing
  cli/            → CLI entry point
domains/
  echo/           → Test domain adapter
tests/
  unit/           → Unit tests per module
contracts/        → Specification contracts
```

## Commands
```bash
npm run build                              # Compile TypeScript
node dist/cli/cli.js search <query>        # TF-IDF search across all domains
node dist/cli/cli.js exec <goal>           # Autonomous pipeline (recall→plan→exec→learn)
node dist/cli/cli.js eval                  # Run model evaluation
node dist/cli/cli.js status                # Store stats, circuit breakers, skills
node dist/cli/cli.js domain list           # List registered domains
```

## Environment variables
- `ANTHROPIC_API_KEY` — for Claude LLM provider
- `OPENAI_API_KEY` — for OpenAI LLM provider
- `OLLAMA_MODEL` — for local Ollama (default: qwen2.5:3b)
- `CF_API_KEY` — for Cloudflare Workers AI
- `CF_ACCOUNT_ID` — for Cloudflare Workers AI

## Entity types (CTT mapping)
| Entity | CTT Role | Description |
|--------|----------|-------------|
| Knowledge | Definitions | Domain operation schemas (endpoints, params, I/O) |
| Skill | Patterns | Proven execution sequences with lifecycle (experimental→proven→deprecated) |
| Memory | Learning | Errors, fixes, optimizations from past executions |
| Profile | Config | Connection configs to external services |

## Key pipeline (Autonomous Agent)
1. RECALL — TF-IDF search finds relevant Knowledge + Skills + Memories
2. PLAN — LLM generates ExecutionPlan JSON with CTT context (few-shot + anti-patterns)
3. NORMALIZE — Response normalizer (JSON extraction) + Plan normalizer (structural fixes)
4. VALIDATE — DomainAdapter.validate()
5. EXECUTE — DomainAdapter.execute()
6. LEARN — Success→save Skill (experimental). Failure→save Memory + update Circuit Breaker

## Guard rails (proven in n8n-a2e + wp-a2e)
- Response normalizer: strip thinking tags, extract JSON, fix trailing commas, auto-close brackets
- Plan normalizer: fix out-of-bounds connections, self-loops, orphans, type coercion
- Circuit breaker: block operations after N consecutive failures, inject anti-patterns into LLM context
- Inline retry: feed execution errors back to LLM for self-correction
- Secret sanitizer: 4-layer credential protection before persisting

## Store location
`.ctt-shell/store/` — Contains knowledge/, skill/, memory/, profile/ per domain

## Zero runtime dependencies
Only Node.js built-ins: crypto, fs, path, http. TypeScript for compilation only.
