/**
 * n8n Domain Adapter — composes and deploys n8n workflows.
 *
 * Unlike the sequential step execution of other domains, n8n workflows are
 * *composed* as a graph (nodes + connections) and deployed via the n8n REST API.
 *
 * operationId format: n8n node type, e.g. "n8n-nodes-base.webhook"
 *
 * The ExecutionPlan steps represent workflow nodes. Each step's operationId
 * is the n8n node type, params are the node parameters, and dependsOn defines
 * the connection graph.
 */

import { randomUUID } from 'node:crypto';
import type { DomainAdapter, PlanNormalizer } from '../../src/domain/adapter.js';
import type { Knowledge, ExecutionPlan, ExecutionResult, ValidationResult, StepResult } from '../../src/types/entities.js';
import { N8nClient, type N8nClientConfig, type N8nWorkflowPayload } from './client.js';

export interface N8nAdapterConfig {
  /** n8n instance URL (e.g., http://localhost:5678) */
  baseUrl?: string;
  /** n8n API key */
  apiKey?: string;
  /** Timeout per request */
  timeout?: number;
  /** Auto-activate deployed workflows */
  autoActivate?: boolean;
}

// Node layout constants
const NODE_SPACING_X = 300;
const NODE_SPACING_Y = 200;
const START_X = 250;
const START_Y = 300;

export class N8nAdapter implements DomainAdapter {
  readonly id = 'n8n';
  readonly name = 'n8n (Workflow Automation)';
  private client: N8nClient | null = null;
  private config: N8nAdapterConfig;

  constructor(config?: N8nAdapterConfig) {
    this.config = config ?? {};
    if (config?.baseUrl && config?.apiKey) {
      this.client = new N8nClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeout: config.timeout,
      });
    }
  }

  /** Connect to an n8n instance (can be called after construction) */
  connect(config: N8nClientConfig): void {
    this.client = new N8nClient(config);
    this.config.baseUrl = config.baseUrl;
  }

  async extractKnowledge(): Promise<Knowledge[]> {
    // If connected to a live instance, try to get actual node types
    if (this.client) {
      try {
        const res = await this.client.getNodeTypes();
        if (res.success && Array.isArray(res.data)) {
          return this.parseNodeTypes(res.data as RawNodeType[]);
        }
      } catch {
        // Fall back to built-in
      }
    }
    return N8N_BUILTIN_KNOWLEDGE;
  }

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    const start = Date.now();

    // For n8n, "execution" means composing the workflow JSON and deploying it
    try {
      const workflow = this.composeWorkflow(plan);

      if (!this.client) {
        // No instance — return the composed workflow as the result
        return {
          success: true,
          goal: plan.goal,
          domainId: 'n8n',
          steps: [{
            stepId: 0,
            operationId: 'n8n.compose',
            success: true,
            response: workflow,
            durationMs: Date.now() - start,
          }],
          totalDurationMs: Date.now() - start,
        };
      }

      // Deploy to n8n
      const deployRes = await this.client.createWorkflow(workflow);
      if (!deployRes.success) {
        return {
          success: false,
          goal: plan.goal,
          domainId: 'n8n',
          steps: [{
            stepId: 0,
            operationId: 'n8n.deploy',
            success: false,
            error: deployRes.error,
            durationMs: Date.now() - start,
          }],
          totalDurationMs: Date.now() - start,
          error: `Deploy failed: ${deployRes.error}`,
        };
      }

      const deployedWorkflow = deployRes.data as { id?: string };

      // Optionally activate
      if (this.config.autoActivate && deployedWorkflow.id) {
        await this.client.activateWorkflow(deployedWorkflow.id);
      }

      return {
        success: true,
        goal: plan.goal,
        domainId: 'n8n',
        steps: [{
          stepId: 0,
          operationId: 'n8n.deploy',
          success: true,
          response: deployedWorkflow,
          durationMs: Date.now() - start,
        }],
        totalDurationMs: Date.now() - start,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        goal: plan.goal,
        domainId: 'n8n',
        steps: [],
        totalDurationMs: Date.now() - start,
        error,
      };
    }
  }

  validate(plan: ExecutionPlan): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const knownTypes = new Set(N8N_BUILTIN_KNOWLEDGE.map(k => k.operationId));

    // Check for trigger node
    const hasTrigger = plan.steps.some(s =>
      s.operationId.includes('Trigger') || s.operationId.includes('trigger') ||
      s.operationId.includes('webhook') || s.operationId.includes('Webhook')
    );
    if (!hasTrigger) warnings.push('Workflow should have a trigger node');

    for (const step of plan.steps) {
      if (!knownTypes.has(step.operationId)) {
        // Not a fatal error — could be a community node
        warnings.push(`Unknown node type: ${step.operationId}`);
      }
      if (step.dependsOn) {
        const validIds = new Set(plan.steps.map(s => s.stepId));
        for (const dep of step.dependsOn) {
          if (!validIds.has(dep)) errors.push(`Step ${step.stepId} depends on non-existent step ${dep}`);
        }
      }
    }

    // Check for duplicate node names
    const names = plan.steps.map(s => s.description);
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) warnings.push(`Duplicate node name: ${n}`);
      seen.add(n);
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  queryExpansions(): Record<string, string[]> {
    return {
      'email': ['gmail', 'smtp', 'imap', 'mail', 'outlook', 'sendgrid'],
      'chat': ['slack', 'discord', 'telegram', 'mattermost', 'teams'],
      'database': ['mysql', 'postgres', 'mongodb', 'redis', 'sqlite'],
      'file': ['ftp', 'sftp', 's3', 'drive', 'dropbox'],
      'spreadsheet': ['sheets', 'excel', 'csv', 'airtable'],
      'crm': ['salesforce', 'hubspot', 'pipedrive'],
      'ai': ['openai', 'gpt', 'langchain', 'anthropic', 'ollama'],
      'notification': ['slack', 'email', 'sms', 'push', 'webhook'],
      'schedule': ['cron', 'interval', 'timer', 'trigger'],
      'http': ['webhook', 'request', 'api', 'rest', 'fetch'],
      'transform': ['set', 'code', 'function', 'map', 'filter'],
      'condition': ['if', 'switch', 'filter', 'branch'],
    };
  }

  planNormalizers(): PlanNormalizer[] {
    return [
      (plan, fixes) => {
        for (const step of plan.steps) {
          const opId = step.operationId;

          // Fix common shorthand: "webhook" → "n8n-nodes-base.webhook"
          if (opId && !opId.includes('.') && !opId.includes('-')) {
            const match = N8N_BUILTIN_KNOWLEDGE.find(k => {
              const shortName = k.operationId.split('.').pop()?.toLowerCase();
              return shortName === opId.toLowerCase();
            });
            if (match) {
              fixes.push(`fixed node type "${opId}" → "${match.operationId}"`);
              step.operationId = match.operationId;
            }
          }

          // Fix "nodes-base.X" → "n8n-nodes-base.X"
          if (opId.startsWith('nodes-base.')) {
            step.operationId = 'n8n-' + opId;
            fixes.push(`added "n8n-" prefix to "${opId}"`);
          }

          // Ensure IF nodes have proper connection references
          if (step.operationId === 'n8n-nodes-base.if') {
            // IF nodes have 2 outputs: 0=true, 1=false
            // Ensure dependents reference the correct output
          }
        }
      },
    ];
  }

  /** Check if n8n instance is reachable */
  async isAvailable(): Promise<boolean> {
    if (!this.client) return false;
    const { ok } = await this.client.ping();
    return ok;
  }

  // ─── Workflow Composition ──────────────────────────────────────────────────

  private composeWorkflow(plan: ExecutionPlan): N8nWorkflowPayload {
    // Build nodes
    const nodes = plan.steps.map((step, i) => ({
      id: randomUUID(),
      name: step.description || `Node ${step.stepId}`,
      type: step.operationId,
      typeVersion: 1,
      position: [START_X + i * NODE_SPACING_X, START_Y] as [number, number],
      parameters: step.params,
    }));

    // Auto-layout using BFS depth
    const positions = this.layoutNodes(plan);
    for (let i = 0; i < nodes.length; i++) {
      if (positions[i]) nodes[i].position = positions[i];
    }

    // Deduplicate names
    const nameCount = new Map<string, number>();
    for (const node of nodes) {
      const count = nameCount.get(node.name) ?? 0;
      nameCount.set(node.name, count + 1);
      if (count > 0) node.name = `${node.name} ${count}`;
    }

    // Build connections from dependsOn
    const connections: N8nWorkflowPayload['connections'] = {};
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (!step.dependsOn) continue;

      for (const depId of step.dependsOn) {
        const depIdx = plan.steps.findIndex(s => s.stepId === depId);
        if (depIdx < 0) continue;

        const sourceName = nodes[depIdx].name;
        if (!connections[sourceName]) connections[sourceName] = {};
        if (!connections[sourceName]['main']) connections[sourceName]['main'] = [[]];

        connections[sourceName]['main'][0].push({
          node: nodes[i].name,
          type: 'main',
          index: 0,
        });
      }
    }

    return {
      name: plan.goal,
      nodes,
      connections,
      settings: { executionOrder: 'v1' },
      active: false,
    };
  }

  private layoutNodes(plan: ExecutionPlan): Array<[number, number]> {
    const n = plan.steps.length;
    const depths = new Array(n).fill(0);

    // Build adjacency from dependsOn
    const adjacency: number[][] = plan.steps.map(() => []);
    const stepIdToIdx = new Map<number, number>();
    plan.steps.forEach((s, i) => stepIdToIdx.set(s.stepId, i));

    for (let i = 0; i < plan.steps.length; i++) {
      const deps = plan.steps[i].dependsOn;
      if (deps) {
        for (const dep of deps) {
          const depIdx = stepIdToIdx.get(dep);
          if (depIdx !== undefined) adjacency[depIdx].push(i);
        }
      }
    }

    // Find roots
    const hasIncoming = new Set<number>();
    for (const step of plan.steps) {
      if (step.dependsOn) {
        const idx = stepIdToIdx.get(step.stepId);
        if (idx !== undefined) hasIncoming.add(idx);
      }
    }
    const roots = Array.from({ length: n }, (_, i) => i).filter(i => !hasIncoming.has(i));

    // BFS
    const queue = roots.length > 0 ? [...roots] : [0];
    const visited = new Set(queue);
    for (const r of queue) depths[r] = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of adjacency[current]) {
        depths[next] = Math.max(depths[next], depths[current] + 1);
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    // Position by depth
    const byDepth = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      if (!byDepth.has(depths[i])) byDepth.set(depths[i], []);
      byDepth.get(depths[i])!.push(i);
    }

    const positions: Array<[number, number]> = new Array(n);
    for (const [depth, indices] of byDepth) {
      const colHeight = indices.length * NODE_SPACING_Y;
      const startY = START_Y - colHeight / 2;
      for (let j = 0; j < indices.length; j++) {
        positions[indices[j]] = [
          START_X + depth * NODE_SPACING_X,
          startY + j * NODE_SPACING_Y,
        ];
      }
    }

    return positions;
  }

  private parseNodeTypes(rawNodes: RawNodeType[]): Knowledge[] {
    return rawNodes.map(node => {
      const category = this.inferCategory(node);
      const params = (node.properties ?? []).slice(0, 10).map((p: RawProperty) => ({
        name: p.name,
        type: p.type ?? 'string',
        description: p.description ?? p.displayName ?? '',
        required: p.required ?? false,
        default: p.default,
      }));

      return {
        id: `n8n-${node.name.replace(/[^a-z0-9]/gi, '-')}`,
        type: 'knowledge' as const,
        domainId: 'n8n',
        createdAt: '',
        updatedAt: '',
        tags: [category, ...node.group ?? [], 'n8n'],
        operationId: node.name,
        displayName: node.displayName ?? node.name,
        description: node.description ?? `${node.displayName} node for n8n`,
        category,
        parameters: params,
      };
    });
  }

  private inferCategory(node: RawNodeType): string {
    if (node.group?.includes('trigger')) return 'trigger';
    const name = node.name.toLowerCase();
    if (name.includes('trigger')) return 'trigger';
    if (name.includes('if') || name.includes('switch') || name.includes('merge')) return 'flow';
    if (name.includes('set') || name.includes('code') || name.includes('function')) return 'transform';
    if (name.includes('openai') || name.includes('langchain') || name.includes('agent')) return 'ai';
    return 'action';
  }
}

// ─── Raw n8n types (for instance extraction) ─────────────────────────────────

interface RawNodeType {
  name: string;
  displayName?: string;
  description?: string;
  group?: string[];
  properties?: RawProperty[];
}

interface RawProperty {
  name: string;
  displayName?: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

// ─── Built-in n8n Knowledge ──────────────────────────────────────────────────
// Core node types available in any standard n8n installation.

const N8N_BUILTIN_KNOWLEDGE: Knowledge[] = [
  // Triggers
  {
    id: 'n8n-webhook', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['trigger', 'webhook', 'n8n'],
    operationId: 'n8n-nodes-base.webhook', displayName: 'Webhook',
    description: 'Starts the workflow when an HTTP request is received.',
    category: 'trigger',
    parameters: [
      { name: 'httpMethod', type: 'string', description: 'HTTP method to listen for', required: true, enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
      { name: 'path', type: 'string', description: 'Webhook path', required: true },
      { name: 'responseMode', type: 'string', description: 'Response mode', required: false },
    ],
  },
  {
    id: 'n8n-schedule-trigger', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['trigger', 'schedule', 'cron', 'n8n'],
    operationId: 'n8n-nodes-base.scheduleTrigger', displayName: 'Schedule Trigger',
    description: 'Starts the workflow on a schedule (cron expression or interval).',
    category: 'trigger',
    parameters: [
      { name: 'rule', type: 'object', description: 'Schedule rule (interval or cron)', required: true },
    ],
  },
  {
    id: 'n8n-manual-trigger', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['trigger', 'manual', 'n8n'],
    operationId: 'n8n-nodes-base.manualTrigger', displayName: 'Manual Trigger',
    description: 'Starts the workflow manually (for testing).',
    category: 'trigger',
    parameters: [],
  },
  {
    id: 'n8n-email-trigger', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['trigger', 'email', 'imap', 'n8n'],
    operationId: 'n8n-nodes-base.emailReadImap', displayName: 'Email Trigger (IMAP)',
    description: 'Triggers on new emails via IMAP.',
    category: 'trigger',
    parameters: [],
  },

  // HTTP / API
  {
    id: 'n8n-http-request', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['action', 'http', 'api', 'request', 'n8n'],
    operationId: 'n8n-nodes-base.httpRequest', displayName: 'HTTP Request',
    description: 'Makes an HTTP request to any URL. Supports GET, POST, PUT, DELETE.',
    category: 'action',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to request', required: true },
      { name: 'method', type: 'string', description: 'HTTP method', required: true, enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
      { name: 'authentication', type: 'string', description: 'Authentication type', required: false },
      { name: 'body', type: 'object', description: 'Request body', required: false },
    ],
  },
  {
    id: 'n8n-respond-webhook', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['action', 'webhook', 'response', 'n8n'],
    operationId: 'n8n-nodes-base.respondToWebhook', displayName: 'Respond to Webhook',
    description: 'Sends a response back to the webhook caller.',
    category: 'action',
    parameters: [
      { name: 'respondWith', type: 'string', description: 'Response type', required: true },
    ],
  },

  // Flow Control
  {
    id: 'n8n-if', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['flow', 'condition', 'if', 'branch', 'n8n'],
    operationId: 'n8n-nodes-base.if', displayName: 'IF',
    description: 'Routes items based on a condition. Output 0 = true, Output 1 = false.',
    category: 'flow',
    parameters: [
      { name: 'conditions', type: 'object', description: 'Condition rules', required: true },
    ],
  },
  {
    id: 'n8n-switch', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['flow', 'condition', 'switch', 'route', 'n8n'],
    operationId: 'n8n-nodes-base.switch', displayName: 'Switch',
    description: 'Routes items to different outputs based on matching rules.',
    category: 'flow',
    parameters: [
      { name: 'rules', type: 'object', description: 'Routing rules', required: true },
    ],
  },
  {
    id: 'n8n-merge', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['flow', 'merge', 'combine', 'n8n'],
    operationId: 'n8n-nodes-base.merge', displayName: 'Merge',
    description: 'Merges data from multiple inputs.',
    category: 'flow',
    parameters: [
      { name: 'mode', type: 'string', description: 'Merge mode', required: true },
    ],
  },

  // Transform
  {
    id: 'n8n-set', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['transform', 'set', 'assign', 'n8n'],
    operationId: 'n8n-nodes-base.set', displayName: 'Set',
    description: 'Sets or modifies field values on items.',
    category: 'transform',
    parameters: [
      { name: 'assignments', type: 'object', description: 'Field assignments', required: true },
    ],
  },
  {
    id: 'n8n-code', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['transform', 'code', 'javascript', 'function', 'n8n'],
    operationId: 'n8n-nodes-base.code', displayName: 'Code',
    description: 'Execute custom JavaScript code to transform data.',
    category: 'transform',
    parameters: [
      { name: 'jsCode', type: 'string', description: 'JavaScript code to execute', required: true },
    ],
  },
  {
    id: 'n8n-filter', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['transform', 'filter', 'n8n'],
    operationId: 'n8n-nodes-base.filter', displayName: 'Filter',
    description: 'Filters items based on conditions.',
    category: 'transform',
    parameters: [
      { name: 'conditions', type: 'object', description: 'Filter conditions', required: true },
    ],
  },

  // Integrations
  {
    id: 'n8n-slack', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['action', 'slack', 'chat', 'notification', 'n8n'],
    operationId: 'n8n-nodes-base.slack', displayName: 'Slack',
    description: 'Send messages, manage channels, and interact with Slack.',
    category: 'action',
    parameters: [
      { name: 'resource', type: 'string', description: 'Resource (message, channel)', required: true },
      { name: 'operation', type: 'string', description: 'Operation (send, get, etc.)', required: true },
    ],
  },
  {
    id: 'n8n-gmail', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['action', 'gmail', 'email', 'n8n'],
    operationId: 'n8n-nodes-base.gmail', displayName: 'Gmail',
    description: 'Send, read, and manage Gmail emails.',
    category: 'action',
    parameters: [
      { name: 'resource', type: 'string', description: 'Resource (message, draft)', required: true },
      { name: 'operation', type: 'string', description: 'Operation (send, get, etc.)', required: true },
    ],
  },
  {
    id: 'n8n-google-sheets', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['action', 'sheets', 'spreadsheet', 'google', 'n8n'],
    operationId: 'n8n-nodes-base.googleSheets', displayName: 'Google Sheets',
    description: 'Read and write Google Sheets data.',
    category: 'action',
    parameters: [
      { name: 'operation', type: 'string', description: 'Operation (append, read, update)', required: true },
      { name: 'sheetId', type: 'string', description: 'Spreadsheet ID', required: true },
    ],
  },
  {
    id: 'n8n-telegram', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['action', 'telegram', 'chat', 'notification', 'n8n'],
    operationId: 'n8n-nodes-base.telegram', displayName: 'Telegram',
    description: 'Send messages and interact with Telegram bots.',
    category: 'action',
    parameters: [
      { name: 'resource', type: 'string', description: 'Resource (message, chat)', required: true },
      { name: 'operation', type: 'string', description: 'Operation (send, get)', required: true },
    ],
  },

  // AI
  {
    id: 'n8n-openai', type: 'knowledge', domainId: 'n8n',
    createdAt: '', updatedAt: '', tags: ['ai', 'openai', 'gpt', 'llm', 'n8n'],
    operationId: '@n8n/n8n-nodes-langchain.openAi', displayName: 'OpenAI',
    description: 'Interact with OpenAI models (GPT, embeddings, images).',
    category: 'ai',
    parameters: [
      { name: 'resource', type: 'string', description: 'Resource (chat, text, image)', required: true },
      { name: 'model', type: 'string', description: 'Model name', required: false },
      { name: 'prompt', type: 'string', description: 'Prompt text', required: false },
    ],
  },
];

// ─── Eval Goals ──────────────────────────────────────────────────────────────

export const N8N_EVAL_GOALS = [
  // Simple (2-3 nodes)
  {
    goal: 'Create a webhook that returns a JSON response with a greeting message',
    domainId: 'n8n', complexity: 'simple' as const,
    expectedOps: ['n8n-nodes-base.webhook', 'n8n-nodes-base.respondToWebhook'],
  },
  {
    goal: 'Create a workflow that runs every hour and makes an HTTP GET request to https://api.example.com/status',
    domainId: 'n8n', complexity: 'simple' as const,
    expectedOps: ['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.httpRequest'],
  },
  {
    goal: 'Create a manual trigger workflow that sets a field "uuid" with a random value',
    domainId: 'n8n', complexity: 'simple' as const,
    expectedOps: ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set'],
  },

  // Medium (3-5 nodes)
  {
    goal: 'Create a webhook that receives data, filters items where status is "active", and responds with the filtered results',
    domainId: 'n8n', complexity: 'medium' as const,
    expectedOps: ['n8n-nodes-base.webhook', 'n8n-nodes-base.if', 'n8n-nodes-base.respondToWebhook'],
  },
  {
    goal: 'Create a scheduled workflow that fetches data from an API and sends a summary to Slack',
    domainId: 'n8n', complexity: 'medium' as const,
    expectedOps: ['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.slack'],
  },

  // Complex
  {
    goal: 'Create a webhook that receives JSON with a "type" field. If type is "urgent", send a Slack notification. Otherwise, save data to Google Sheets.',
    domainId: 'n8n', complexity: 'complex' as const,
    expectedOps: ['n8n-nodes-base.webhook', 'n8n-nodes-base.if', 'n8n-nodes-base.slack', 'n8n-nodes-base.googleSheets'],
  },
];
