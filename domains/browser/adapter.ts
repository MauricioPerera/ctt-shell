/**
 * Browser Domain Adapter — controls Chrome via PinchTab CDP.
 *
 * Operations: navigate, click, fill, type, find, snapshot, screenshot,
 * evaluate, press, scroll, select, text, wait, tabs.
 *
 * This domain enables LLM agents to browse the web, fill forms,
 * take screenshots, and interact with any web UI.
 */

import type { DomainAdapter, PlanNormalizer } from '../../src/domain/adapter.js';
import type { Knowledge, ExecutionPlan, ExecutionResult, ValidationResult, StepResult } from '../../src/types/entities.js';
import { PinchTabClient, type PinchTabResponse } from './client.js';

export interface BrowserAdapterConfig {
  /** PinchTab server URL (default: http://127.0.0.1:9867) */
  pinchtabUrl?: string;
  /** Base URL for resolving relative paths (e.g., http://localhost) */
  baseUrl?: string;
  /** Timeout per action in ms */
  timeout?: number;
}

export class BrowserAdapter implements DomainAdapter {
  readonly id = 'browser';
  readonly name = 'Browser (PinchTab/Chrome CDP)';
  private client: PinchTabClient;
  private baseUrl: string;

  constructor(config?: BrowserAdapterConfig) {
    this.client = new PinchTabClient({
      baseUrl: config?.pinchtabUrl,
      timeout: config?.timeout,
    });
    this.baseUrl = (config?.baseUrl ?? 'http://localhost').replace(/\/+$/, '');
  }

  async extractKnowledge(): Promise<Knowledge[]> {
    return BROWSER_KNOWLEDGE;
  }

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    const start = Date.now();
    const outputs = new Map<string, unknown>();
    const stepResults: StepResult[] = [];

    for (const step of plan.steps) {
      const stepStart = Date.now();

      // Resolve {{ref.field}} in all param values
      const params = this.resolveRefs(step.params, outputs);
      const opId = step.operationId;

      try {
        let result: PinchTabResponse;

        switch (opId) {
          case 'browser.navigate': {
            let url = String(params.url ?? '');
            if (url.startsWith('/')) url = `${this.baseUrl}${url}`;
            result = await this.client.navigate(url, params.waitUntil as 'load' | undefined);
            // Wait after navigation
            if (params.waitMs) await this.wait(Number(params.waitMs));
            break;
          }
          case 'browser.click':
            result = await this.client.click(String(params.ref ?? params.target ?? ''));
            break;
          case 'browser.fill':
            result = await this.client.fill(String(params.ref ?? params.target ?? ''), String(params.value ?? ''));
            break;
          case 'browser.type':
            result = await this.client.type(String(params.ref ?? params.target ?? ''), String(params.value ?? ''));
            break;
          case 'browser.find':
            result = await this.client.find(String(params.query ?? params.value ?? ''));
            break;
          case 'browser.snapshot':
            result = await this.client.snapshot();
            break;
          case 'browser.screenshot':
            result = await this.client.screenshot({ fullPage: !!params.fullPage, selector: params.selector as string });
            break;
          case 'browser.evaluate':
            result = await this.client.evaluate(String(params.expression ?? params.value ?? ''));
            break;
          case 'browser.press':
            result = await this.client.press(String(params.key ?? params.value ?? 'Enter'));
            break;
          case 'browser.scroll':
            result = await this.client.scroll(
              (params.direction as 'up' | 'down') ?? 'down',
              params.ref as string | undefined,
            );
            break;
          case 'browser.select':
            result = await this.client.select(String(params.ref ?? params.target ?? ''), String(params.value ?? ''));
            break;
          case 'browser.text':
            result = await this.client.text();
            break;
          case 'browser.wait':
            await this.wait(Number(params.ms ?? params.waitMs ?? 1000));
            result = { success: true };
            break;
          case 'browser.back':
            result = await this.client.back();
            break;
          case 'browser.forward':
            result = await this.client.forward();
            break;
          case 'browser.reload':
            result = await this.client.reload();
            break;
          case 'browser.tabs.list':
            result = await this.client.listTabs();
            break;
          case 'browser.tabs.new':
            result = await this.client.newTab(params.url as string | undefined);
            break;
          case 'browser.tabs.close':
            result = await this.client.closeTab(String(params.tabId ?? ''));
            break;
          default:
            result = { success: false, error: `Unknown operation: ${opId}` };
        }

        // Extract best_ref from find results for easier chaining
        let responseData: unknown = result.data;
        if (opId === 'browser.find' && result.success && typeof result.data === 'object' && result.data !== null) {
          const findData = result.data as Record<string, unknown>;
          const bestRef = findData.best_ref ?? findData.bestRef;
          if (bestRef && typeof bestRef === 'string') {
            responseData = { ref: bestRef, raw: result.data };
          }
        }

        if (step.outputRef && responseData !== undefined) {
          outputs.set(step.outputRef, responseData);
        }

        stepResults.push({
          stepId: step.stepId,
          operationId: opId,
          success: result.success,
          response: responseData,
          error: result.error,
          durationMs: Date.now() - stepStart,
        });

        if (!result.success) {
          return {
            success: false,
            goal: plan.goal,
            domainId: 'browser',
            steps: stepResults,
            totalDurationMs: Date.now() - start,
            error: `Step ${step.stepId} (${opId}) failed: ${result.error}`,
          };
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        stepResults.push({
          stepId: step.stepId,
          operationId: opId,
          success: false,
          error,
          durationMs: Date.now() - stepStart,
        });
        return {
          success: false,
          goal: plan.goal,
          domainId: 'browser',
          steps: stepResults,
          totalDurationMs: Date.now() - start,
          error,
        };
      }
    }

    return {
      success: true,
      goal: plan.goal,
      domainId: 'browser',
      steps: stepResults,
      totalDurationMs: Date.now() - start,
    };
  }

  validate(plan: ExecutionPlan): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const knownOps = new Set(BROWSER_KNOWLEDGE.map(k => k.operationId));

    for (const step of plan.steps) {
      if (!knownOps.has(step.operationId)) {
        warnings.push(`Unknown operation: ${step.operationId}`);
      }
      if (step.dependsOn) {
        const validIds = new Set(plan.steps.map(s => s.stepId));
        for (const dep of step.dependsOn) {
          if (!validIds.has(dep)) errors.push(`Step ${step.stepId} depends on non-existent step ${dep}`);
        }
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  queryExpansions(): Record<string, string[]> {
    return {
      'browse': ['navigate', 'open', 'go', 'visit', 'url'],
      'click': ['press', 'tap', 'select', 'button'],
      'fill': ['type', 'input', 'write', 'enter', 'form'],
      'screenshot': ['capture', 'image', 'photo', 'visual'],
      'search': ['find', 'locate', 'look', 'query'],
      'page': ['website', 'site', 'web', 'html', 'dom'],
      'form': ['input', 'field', 'text', 'submit', 'fill'],
      'login': ['signin', 'auth', 'credentials', 'password'],
      'tab': ['window', 'browser'],
    };
  }

  planNormalizers(): PlanNormalizer[] {
    return [
      // Fix common 3B model issues with browser operations
      (plan, fixes) => {
        for (const step of plan.steps) {
          // Normalize operation IDs: "navigate" → "browser.navigate"
          if (step.operationId && !step.operationId.startsWith('browser.')) {
            const shortOp = step.operationId.toLowerCase();
            const match = BROWSER_KNOWLEDGE.find(k =>
              k.operationId === `browser.${shortOp}` ||
              k.operationId.endsWith(`.${shortOp}`)
            );
            if (match) {
              fixes.push(`fixed operationId "${step.operationId}" → "${match.operationId}"`);
              step.operationId = match.operationId;
            }
          }
          // Ensure navigate has url param
          if (step.operationId === 'browser.navigate' && !step.params.url && step.params.value) {
            step.params.url = step.params.value;
            delete step.params.value;
            fixes.push('moved value → url for navigate');
          }
        }
      },
    ];
  }

  /** Check if PinchTab is reachable */
  async isAvailable(): Promise<boolean> {
    const { ok } = await this.client.ping();
    return ok;
  }

  private resolveRefs(params: Record<string, unknown>, outputs: Map<string, unknown>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.includes('{{')) {
        resolved[key] = value.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_m, ref, field) => {
          const output = outputs.get(ref) as Record<string, unknown> | undefined;
          return output?.[field] !== undefined ? String(output[field]) : `{{${ref}.${field}}}`;
        });
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  private wait(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ─── Browser Knowledge Entities ─────────────────────────────────────────────

const BROWSER_KNOWLEDGE: Knowledge[] = [
  {
    id: 'browser-navigate', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'navigate', 'url'],
    operationId: 'browser.navigate', displayName: 'Navigate to URL',
    description: 'Opens a URL in the browser. Supports absolute URLs and relative paths.',
    category: 'navigation',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to navigate to', required: true },
      { name: 'waitMs', type: 'number', description: 'Wait after navigation (ms)', required: false, default: 1000 },
    ],
  },
  {
    id: 'browser-click', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'click', 'interact'],
    operationId: 'browser.click', displayName: 'Click Element',
    description: 'Clicks an element by its ref (from snapshot or find).',
    category: 'interaction',
    parameters: [
      { name: 'ref', type: 'string', description: 'Element ref from snapshot/find', required: true },
    ],
  },
  {
    id: 'browser-fill', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'fill', 'form', 'input'],
    operationId: 'browser.fill', displayName: 'Fill Form Field',
    description: 'Clears and fills a form field with text.',
    category: 'interaction',
    parameters: [
      { name: 'ref', type: 'string', description: 'Element ref', required: true },
      { name: 'value', type: 'string', description: 'Text to fill', required: true },
    ],
  },
  {
    id: 'browser-type', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'type', 'keyboard'],
    operationId: 'browser.type', displayName: 'Type Text',
    description: 'Types text into an element (appends, does not clear).',
    category: 'interaction',
    parameters: [
      { name: 'ref', type: 'string', description: 'Element ref', required: true },
      { name: 'value', type: 'string', description: 'Text to type', required: true },
    ],
  },
  {
    id: 'browser-find', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'find', 'search', 'locate'],
    operationId: 'browser.find', displayName: 'Find Element',
    description: 'Semantically searches for an element by text/description. Returns ref for use in click/fill.',
    category: 'analysis',
    parameters: [
      { name: 'query', type: 'string', description: 'Text to search for', required: true },
    ],
  },
  {
    id: 'browser-snapshot', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'snapshot', 'accessibility', 'dom'],
    operationId: 'browser.snapshot', displayName: 'Page Snapshot',
    description: 'Gets accessibility tree snapshot of the current page (~800 tokens). Returns element refs.',
    category: 'analysis',
    parameters: [],
  },
  {
    id: 'browser-screenshot', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'screenshot', 'image', 'visual'],
    operationId: 'browser.screenshot', displayName: 'Take Screenshot',
    description: 'Takes a screenshot of the current page (base64 PNG).',
    category: 'analysis',
    parameters: [
      { name: 'fullPage', type: 'boolean', description: 'Capture full page', required: false },
      { name: 'selector', type: 'string', description: 'CSS selector for specific element', required: false },
    ],
  },
  {
    id: 'browser-evaluate', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'evaluate', 'javascript', 'js'],
    operationId: 'browser.evaluate', displayName: 'Execute JavaScript',
    description: 'Executes a JavaScript expression in the page context. Returns the result.',
    category: 'advanced',
    parameters: [
      { name: 'expression', type: 'string', description: 'JavaScript expression to evaluate', required: true },
    ],
  },
  {
    id: 'browser-text', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'text', 'content', 'read'],
    operationId: 'browser.text', displayName: 'Get Page Text',
    description: 'Gets the full text content of the current page.',
    category: 'analysis',
    parameters: [],
  },
  {
    id: 'browser-press', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'press', 'key', 'keyboard'],
    operationId: 'browser.press', displayName: 'Press Key',
    description: 'Presses a keyboard key (Enter, Tab, Escape, etc.).',
    category: 'interaction',
    parameters: [
      { name: 'key', type: 'string', description: 'Key name (Enter, Tab, Escape, etc.)', required: true },
    ],
  },
  {
    id: 'browser-scroll', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'scroll'],
    operationId: 'browser.scroll', displayName: 'Scroll Page',
    description: 'Scrolls the page up or down.',
    category: 'interaction',
    parameters: [
      { name: 'direction', type: 'string', description: 'up or down', required: true, enum: ['up', 'down'] },
      { name: 'ref', type: 'string', description: 'Element ref to scroll within (optional)', required: false },
    ],
  },
  {
    id: 'browser-select', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'select', 'dropdown'],
    operationId: 'browser.select', displayName: 'Select Option',
    description: 'Selects an option from a dropdown element.',
    category: 'interaction',
    parameters: [
      { name: 'ref', type: 'string', description: 'Dropdown element ref', required: true },
      { name: 'value', type: 'string', description: 'Option value to select', required: true },
    ],
  },
  {
    id: 'browser-wait', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'wait', 'delay'],
    operationId: 'browser.wait', displayName: 'Wait',
    description: 'Waits for a specified duration (for page loads, animations).',
    category: 'utility',
    parameters: [
      { name: 'ms', type: 'number', description: 'Duration in milliseconds', required: true },
    ],
  },
  {
    id: 'browser-back', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'back', 'navigate'],
    operationId: 'browser.back', displayName: 'Go Back',
    description: 'Navigates back in browser history.',
    category: 'navigation',
    parameters: [],
  },
  {
    id: 'browser-forward', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'forward', 'navigate'],
    operationId: 'browser.forward', displayName: 'Go Forward',
    description: 'Navigates forward in browser history.',
    category: 'navigation',
    parameters: [],
  },
  {
    id: 'browser-reload', type: 'knowledge', domainId: 'browser',
    createdAt: '', updatedAt: '', tags: ['browser', 'reload', 'refresh'],
    operationId: 'browser.reload', displayName: 'Reload Page',
    description: 'Reloads the current page.',
    category: 'navigation',
    parameters: [],
  },
];

// ─── Eval Goals ─────────────────────────────────────────────────────────────

export const BROWSER_EVAL_GOALS = [
  {
    goal: 'Navigate to https://example.com',
    domainId: 'browser', complexity: 'simple' as const,
    expectedOps: ['browser.navigate'],
  },
  {
    goal: 'Take a screenshot of the current page',
    domainId: 'browser', complexity: 'simple' as const,
    expectedOps: ['browser.screenshot'],
  },
  {
    goal: 'Get the text content of the page',
    domainId: 'browser', complexity: 'simple' as const,
    expectedOps: ['browser.text'],
  },
  {
    goal: 'Find the search input and type "hello world" into it',
    domainId: 'browser', complexity: 'medium' as const,
    expectedOps: ['browser.find', 'browser.fill'],
  },
  {
    goal: 'Navigate to https://example.com, take a snapshot, and screenshot the page',
    domainId: 'browser', complexity: 'medium' as const,
    expectedOps: ['browser.navigate', 'browser.snapshot', 'browser.screenshot'],
  },
  {
    goal: 'Navigate to a login page, find username field, fill it with "admin", find password field, fill it with "pass123", then click the login button',
    domainId: 'browser', complexity: 'complex' as const,
    expectedOps: ['browser.navigate', 'browser.find', 'browser.fill', 'browser.find', 'browser.fill', 'browser.find', 'browser.click'],
  },
];
