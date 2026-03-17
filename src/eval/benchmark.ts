/**
 * Benchmark Harness — measures performance of CTT-Shell operations.
 * Zero dependencies (uses Date.now() for timing).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../storage/store.js';
import { SearchEngine } from '../search/tfidf.js';
import { normalizeResponse } from '../guardrails/normalize-response.js';
import { normalizePlan } from '../guardrails/normalize-plan.js';
import type { Knowledge, ExecutionPlan } from '../types/entities.js';

export interface BenchmarkResult {
  name: string;
  iterations: number;
  minMs: number;
  avgMs: number;
  maxMs: number;
  p95Ms: number;
}

function measure(name: string, fn: () => void, iterations = 100): BenchmarkResult {
  const times: number[] = [];

  // Warmup
  for (let i = 0; i < 3; i++) fn();

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    fn();
    times.push(Date.now() - start);
  }

  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const p95Index = Math.floor(times.length * 0.95);

  return {
    name,
    iterations,
    minMs: times[0],
    avgMs: +(sum / times.length).toFixed(2),
    maxMs: times[times.length - 1],
    p95Ms: times[p95Index],
  };
}

function generateKnowledge(count: number): Knowledge[] {
  const entities: Knowledge[] = [];
  for (let i = 0; i < count; i++) {
    entities.push({
      id: `bench-k-${i}`,
      type: 'knowledge',
      domainId: 'benchmark',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: ['benchmark', `cat-${i % 5}`, `type-${i % 3}`],
      operationId: `bench.op${i}.action`,
      displayName: `Benchmark Operation ${i}`,
      description: `This is operation number ${i} that performs benchmark task ${i % 10} with parameters`,
      category: `category-${i % 5}`,
      parameters: [
        { name: 'param1', type: 'string', required: true, description: `Parameter for op ${i}` },
        { name: 'param2', type: 'number', required: false, description: 'Optional count' },
      ],
    });
  }
  return entities;
}

function generatePlan(steps: number): ExecutionPlan {
  return {
    goal: 'Benchmark plan',
    steps: Array.from({ length: steps }, (_, i) => ({
      stepId: i + 1,
      operationId: `bench.op${i}.action`,
      description: `Step ${i + 1} description`,
      params: { param1: `value-${i}`, param2: i },
      dependsOn: i > 0 ? [i] : undefined,
    })),
  };
}

/** Run all benchmarks and return results */
export function runBenchmarks(): BenchmarkResult[] {
  const results: BenchmarkResult[] = [];

  // ─── search.index ───────────────────────────────────────────────────

  for (const count of [100, 500, 1000]) {
    const entities = generateKnowledge(count);
    const search = new SearchEngine();
    results.push(measure(`search.index (${count} entities)`, () => {
      search.index(entities);
    }, 50));
  }

  // ─── search.addToIndex ──────────────────────────────────────────────

  {
    const base = generateKnowledge(500);
    const extra = generateKnowledge(10).map((k, i) => ({ ...k, id: `extra-${i}` }));
    const search = new SearchEngine();
    search.index(base);
    results.push(measure('search.addToIndex (10 to 500)', () => {
      search.addToIndex(extra);
    }, 100));
  }

  // ─── search.search ─────────────────────────────────────────────────

  {
    const entities = generateKnowledge(500);
    const search = new SearchEngine();
    search.index(entities);
    const queries = ['create item', 'list operations', 'update benchmark', 'delete task', 'search query'];
    let qi = 0;
    results.push(measure('search.search (500 indexed)', () => {
      search.search(queries[qi++ % queries.length]);
    }, 200));
  }

  // ─── normalizeResponse ─────────────────────────────────────────────

  const jsonInputs = [
    '```json\n{"goal":"test","steps":[{"stepId":1,"operationId":"op","params":{}}]}\n```',
    '<think>reasoning here</think>\n{"goal":"test","steps":[{"stepId":1,"operationId":"op","params":{"name":"value"}}]}',
    "{'goal':'test','steps':[{'stepId':1,'operationId':'op','params':{'key':'val',}}]}",
    '{"goal":"test","steps":[{"stepId":1,"operationId":"op","description":"truncated',
  ];
  let ji = 0;
  results.push(measure('normalizeResponse (varied inputs)', () => {
    normalizeResponse(jsonInputs[ji++ % jsonInputs.length]);
  }, 500));

  // ─── normalizePlan ─────────────────────────────────────────────────

  for (const steps of [5, 20]) {
    const plan = generatePlan(steps);
    results.push(measure(`normalizePlan (${steps} steps)`, () => {
      normalizePlan({ ...plan, steps: plan.steps.map(s => ({ ...s })) });
    }, 200));
  }

  // ─── store.list ────────────────────────────────────────────────────

  for (const count of [50, 200]) {
    const dir = mkdtempSync(join(tmpdir(), 'ctt-bench-'));
    const st = new Store({ root: dir });
    const entities = generateKnowledge(count);
    st.saveBatch(entities);
    results.push(measure(`store.list (${count} entities)`, () => {
      st.list('knowledge');
    }, 50));
    rmSync(dir, { recursive: true, force: true });
  }

  return results;
}

/** Print benchmark results as a table */
export function printBenchmarks(results: BenchmarkResult[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('CTT-Shell Benchmark Results');
  console.log('='.repeat(80));

  const header = 'Benchmark'.padEnd(40) + 'Min'.padStart(8) + 'Avg'.padStart(8) + 'P95'.padStart(8) + 'Max'.padStart(8) + 'Iter'.padStart(8);
  console.log(header);
  console.log('-'.repeat(80));

  for (const r of results) {
    const row = r.name.padEnd(40)
      + `${r.minMs}ms`.padStart(8)
      + `${r.avgMs}ms`.padStart(8)
      + `${r.p95Ms}ms`.padStart(8)
      + `${r.maxMs}ms`.padStart(8)
      + `${r.iterations}`.padStart(8);
    console.log(row);
  }
  console.log('');
}
