#!/usr/bin/env node

/**
 * CTT-Shell CLI
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Store } from '../storage/store.js';
import { SearchEngine } from '../search/tfidf.js';
import { DomainRegistry } from '../domain/registry.js';
import { AutonomousAgent } from '../agent/autonomous.js';
import { ModelEvaluator } from '../eval/evaluator.js';
import { createProvider } from '../llm/provider.js';
import type { ProviderType } from '../llm/provider.js';
import { EchoAdapter, ECHO_EVAL_GOALS } from '../../domains/echo/adapter.js';
import { BrowserAdapter, BROWSER_EVAL_GOALS } from '../../domains/browser/index.js';
import { WordPressAdapter, WP_EVAL_GOALS } from '../../domains/wordpress/index.js';
import { N8nAdapter, N8N_EVAL_GOALS } from '../../domains/n8n/index.js';
import { contextToPrompt, recall } from '../agent/recall.js';
import { CircuitBreaker } from '../guardrails/circuit-breaker.js';

const CTT_ROOT = join(process.cwd(), '.ctt-shell');
const STORE_ROOT = join(CTT_ROOT, 'store');
const CONFIG_PATH = join(CTT_ROOT, 'config.json');

/** Load config from .ctt-shell/config.json and merge with env vars */
function loadConfig(): Record<string, string> {
  const config: Record<string, string> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      Object.assign(config, raw);
    } catch { /* ignore */ }
  }
  return config;
}

function createInfra() {
  const store = new Store({ root: STORE_ROOT });
  const search = new SearchEngine();
  const domains = new DomainRegistry(store, search);

  // Register domains
  domains.register(new EchoAdapter());
  domains.register(new BrowserAdapter());
  domains.register(new WordPressAdapter());
  domains.register(new N8nAdapter());

  // Load and index existing entities
  domains.rebuildIndex();

  return { store, search, domains };
}

function getLlmProvider(): { provider: ProviderType; config: Record<string, unknown> } {
  const cfg = loadConfig();
  // Env vars take precedence over config file
  const cfKey = process.env.CF_API_KEY || cfg.cfApiKey;
  const cfAccount = process.env.CF_ACCOUNT_ID || cfg.cfAccountId;
  const cfModel = cfg.cfModel;
  const cfGateway = cfg.cfGateway;

  if (process.env.ANTHROPIC_API_KEY) return { provider: 'claude', config: { apiKey: process.env.ANTHROPIC_API_KEY } };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', config: { apiKey: process.env.OPENAI_API_KEY } };
  if (cfKey && cfAccount) return { provider: 'cloudflare', config: { apiKey: cfKey, accountId: cfAccount, model: cfModel, gateway: cfGateway } };
  if (cfg.llmProvider === 'cloudflare' && cfKey) return { provider: 'cloudflare', config: { apiKey: cfKey, accountId: cfAccount, model: cfModel, gateway: cfGateway } };
  return { provider: 'ollama', config: { model: process.env.OLLAMA_MODEL || cfg.ollamaModel || 'qwen2.5:3b' } };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help') {
    console.log(`
ctt-shell — Universal AI Agent Framework

Commands:
  search <query>              Search Knowledge + Skills + Memories
  exec <goal>                 Autonomous pipeline (recall→plan→exec→learn)
  eval [--models m1,m2]       Run model evaluation
  extract <domain>            Extract Knowledge from a domain
  status                      Show store statistics
  domain list                 List registered domains
  help                        Show this help

Options:
  --domain <id>               Target domain (default: first registered)
  --models <list>             Comma-separated model specs (provider:model)
  --exec                      Also execute plans in eval mode

Environment:
  ANTHROPIC_API_KEY            Claude API key
  OPENAI_API_KEY               OpenAI API key
  OLLAMA_MODEL                 Ollama model (default: qwen2.5:3b)
  CF_API_KEY + CF_ACCOUNT_ID   Cloudflare Workers AI
`);
    return;
  }

  const { store, search, domains } = createInfra();

  switch (command) {
    case 'search': {
      const query = args.slice(1).join(' ');
      if (!query) { console.error('Usage: ctt-shell search <query>'); process.exit(1); }
      const results = search.search(query, 10);
      if (results.length === 0) {
        console.log('No results found.');
      } else {
        for (const r of results) {
          const e = r.entity as unknown as Record<string, unknown>;
          console.log(`[${r.score.toFixed(2)}] ${e.type as string}: ${(e.displayName || e.name || e.operationId || (e.content as string)?.slice(0, 60)) as string}`);
          console.log(`  Domain: ${e.domainId as string} | Tags: ${(e.tags as string[]).join(', ')}`);
        }
      }
      break;
    }

    case 'exec': {
      const goal = args.slice(1).join(' ');
      if (!goal) { console.error('Usage: ctt-shell exec <goal>'); process.exit(1); }

      const domainFlag = args.indexOf('--domain');
      const domainId = domainFlag >= 0 ? args[domainFlag + 1] : undefined;

      const { provider, config } = getLlmProvider();
      const llm = createProvider(provider, config);

      const agent = new AutonomousAgent({ store, search, domains, llm });
      console.log(`Running autonomous pipeline for: "${goal}"`);
      console.log(`LLM: ${provider} | Domain: ${domainId || domains.list()[0]}`);
      console.log('');

      const result = await agent.run(goal, domainId);

      for (const event of result.events) {
        const icon = event.phase === 'execute' ? (result.success ? '+' : 'x') : '->';
        console.log(`  ${icon} [${event.phase}] ${event.message}`);
      }

      console.log('');
      console.log(result.success ? '+ Success' : `x Failed: ${result.error}`);
      if (result.retries > 0) console.log(`  Retries: ${result.retries}`);
      break;
    }

    case 'eval': {
      const modelsFlag = args.indexOf('--models');
      const modelsStr = modelsFlag >= 0 ? args[modelsFlag + 1] : '';
      const cfg = loadConfig();

      const modelConfigs = modelsStr
        ? modelsStr.split(',').map(m => {
            const [prov, ...modelParts] = m.split(':');
            const model = modelParts.join(':');
            const provType = (prov === 'cf' ? 'cloudflare' : prov) as ProviderType;
            // Merge config file credentials for cloudflare
            const extra: Record<string, unknown> = { model };
            if (provType === 'cloudflare') {
              extra.apiKey = process.env.CF_API_KEY || cfg.cfApiKey;
              extra.accountId = process.env.CF_ACCOUNT_ID || cfg.cfAccountId;
              if (cfg.cfGateway) extra.gateway = cfg.cfGateway;
            }
            return { name: model || prov, provider: provType, config: extra };
          })
        : [{ name: 'ollama-default', provider: 'ollama' as ProviderType, config: { model: process.env.OLLAMA_MODEL || 'qwen2.5:3b' } }];

      // Determine which goals to use
      const domainFlag2 = args.indexOf('--domain');
      const evalDomain = domainFlag2 >= 0 ? args[domainFlag2 + 1] : undefined;

      const goalsByDomain: Record<string, typeof ECHO_EVAL_GOALS> = {
        echo: ECHO_EVAL_GOALS,
        browser: BROWSER_EVAL_GOALS,
        wordpress: WP_EVAL_GOALS,
        n8n: N8N_EVAL_GOALS,
      };

      let evalGoals: typeof ECHO_EVAL_GOALS;
      if (evalDomain && goalsByDomain[evalDomain]) {
        await domains.extractKnowledge(evalDomain);
        evalGoals = goalsByDomain[evalDomain];
      } else {
        // All domains
        for (const d of Object.keys(goalsByDomain)) {
          await domains.extractKnowledge(d);
        }
        evalGoals = Object.values(goalsByDomain).flat();
      }

      // Generate context for goals
      const circuitBreaker = new CircuitBreaker(store);
      const evaluator = new ModelEvaluator({
        contextGenerator: (goal, compact) => {
          const ctx = recall(goal, search, circuitBreaker, { compact });
          return contextToPrompt(ctx, compact);
        },
      });

      console.log(`Running eval: ${evalGoals.length} goals x ${modelConfigs.length} models`);
      console.log('');

      const report = await evaluator.runAll(
        evalGoals,
        modelConfigs,
        (model) => createProvider(model.provider, model.config),
      );

      ModelEvaluator.printReport(report);
      break;
    }

    case 'extract': {
      const domainId = args[1];
      if (!domainId) { console.error('Usage: ctt-shell extract <domain>'); process.exit(1); }
      const count = await domains.extractKnowledge(domainId);
      console.log(`Extracted ${count} Knowledge entities from domain "${domainId}"`);
      break;
    }

    case 'status': {
      const stats = store.stats();
      console.log('CTT-Shell Store Statistics');
      console.log('-'.repeat(40));
      for (const [type, count] of Object.entries(stats)) {
        console.log(`  ${type}: ${count}`);
      }
      console.log(`  Domains: ${domains.list().join(', ') || '(none)'}`);
      break;
    }

    case 'domain': {
      if (args[1] === 'list') {
        const list = domains.list();
        if (list.length === 0) {
          console.log('No domains registered.');
        } else {
          for (const id of list) {
            const adapter = domains.get(id);
            console.log(`  ${id}: ${adapter?.name || 'Unknown'}`);
          }
        }
      } else {
        console.error('Usage: ctt-shell domain list');
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Run "ctt-shell help" for usage.`);
      process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal:', (e as Error).message || e);
  process.exit(1);
});
