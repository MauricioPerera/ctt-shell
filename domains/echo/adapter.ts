/**
 * Echo Domain Adapter — test adapter that echoes operations.
 * Every operation succeeds and returns the input params as output.
 */

import type { DomainAdapter } from '../../src/domain/adapter.js';
import type { Knowledge, ExecutionPlan, ExecutionResult, ValidationResult } from '../../src/types/entities.js';

export class EchoAdapter implements DomainAdapter {
  readonly id = 'echo';
  readonly name = 'Echo (Test Domain)';

  async extractKnowledge(): Promise<Knowledge[]> {
    return ECHO_KNOWLEDGE;
  }

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    const start = Date.now();
    const outputs = new Map<string, unknown>();
    const stepResults = [];

    for (const step of plan.steps) {
      const stepStart = Date.now();

      // Resolve {{ref.field}} in params
      const resolvedParams = this.resolveRefs(step.params, outputs);

      // Simulate execution — echo back params with generated id
      const response = {
        id: Math.floor(Math.random() * 10000),
        ...resolvedParams,
        _echo: true,
        _operation: step.operationId,
      };

      if (step.outputRef) {
        outputs.set(step.outputRef, response);
      }

      stepResults.push({
        stepId: step.stepId,
        operationId: step.operationId,
        success: true,
        response,
        durationMs: Date.now() - stepStart,
      });
    }

    return {
      success: true,
      goal: plan.goal,
      domainId: 'echo',
      steps: stepResults,
      totalDurationMs: Date.now() - start,
    };
  }

  validate(plan: ExecutionPlan): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const knownOps = new Set(ECHO_KNOWLEDGE.map(k => k.operationId));

    for (const step of plan.steps) {
      if (!knownOps.has(step.operationId)) {
        warnings.push(`Unknown operation: ${step.operationId}`);
      }
      // Check deps reference valid step IDs
      if (step.dependsOn) {
        const validIds = new Set(plan.steps.map(s => s.stepId));
        for (const dep of step.dependsOn) {
          if (!validIds.has(dep)) {
            errors.push(`Step ${step.stepId} depends on non-existent step ${dep}`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  queryExpansions(): Record<string, string[]> {
    return {
      'create': ['add', 'new', 'make'],
      'list': ['get', 'fetch', 'query', 'search', 'find'],
      'update': ['modify', 'change', 'edit', 'patch'],
      'delete': ['remove', 'destroy', 'drop'],
      'item': ['record', 'entity', 'object', 'entry'],
      'link': ['connect', 'associate', 'relate'],
    };
  }

  private resolveRefs(params: Record<string, unknown>, outputs: Map<string, unknown>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.includes('{{')) {
        resolved[key] = value.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_match, ref, field) => {
          const output = outputs.get(ref as string) as Record<string, unknown> | undefined;
          return output?.[field as string] !== undefined ? String(output[field as string]) : value;
        });
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}

// Built-in echo Knowledge entities
const ECHO_KNOWLEDGE: Knowledge[] = [
  {
    id: 'echo-items-create', type: 'knowledge', domainId: 'echo',
    createdAt: '', updatedAt: '', tags: ['echo', 'create'],
    operationId: 'echo.items.create', displayName: 'Create Item',
    description: 'Creates a new item with the given properties',
    category: 'items',
    parameters: [
      { name: 'name', type: 'string', description: 'Item name', required: true },
      { name: 'type', type: 'string', description: 'Item type', required: false, default: 'default' },
      { name: 'parentId', type: 'number', description: 'Parent item ID', required: false },
      { name: 'tags', type: 'array', description: 'Item tags', required: false },
    ],
  },
  {
    id: 'echo-items-list', type: 'knowledge', domainId: 'echo',
    createdAt: '', updatedAt: '', tags: ['echo', 'list', 'query'],
    operationId: 'echo.items.list', displayName: 'List Items',
    description: 'Lists all items, optionally filtered by type',
    category: 'items',
    parameters: [
      { name: 'type', type: 'string', description: 'Filter by type', required: false },
      { name: 'limit', type: 'number', description: 'Max results', required: false, default: 10 },
    ],
  },
  {
    id: 'echo-items-get', type: 'knowledge', domainId: 'echo',
    createdAt: '', updatedAt: '', tags: ['echo', 'get', 'read'],
    operationId: 'echo.items.get', displayName: 'Get Item',
    description: 'Gets a single item by ID',
    category: 'items',
    parameters: [
      { name: 'id', type: 'number', description: 'Item ID', required: true },
    ],
  },
  {
    id: 'echo-items-update', type: 'knowledge', domainId: 'echo',
    createdAt: '', updatedAt: '', tags: ['echo', 'update', 'modify'],
    operationId: 'echo.items.update', displayName: 'Update Item',
    description: 'Updates an existing item by ID',
    category: 'items',
    parameters: [
      { name: 'id', type: 'number', description: 'Item ID', required: true },
      { name: 'name', type: 'string', description: 'New name', required: false },
      { name: 'type', type: 'string', description: 'New type', required: false },
    ],
  },
  {
    id: 'echo-items-delete', type: 'knowledge', domainId: 'echo',
    createdAt: '', updatedAt: '', tags: ['echo', 'delete', 'remove'],
    operationId: 'echo.items.delete', displayName: 'Delete Item',
    description: 'Deletes an item by ID',
    category: 'items',
    parameters: [
      { name: 'id', type: 'number', description: 'Item ID', required: true },
    ],
  },
  {
    id: 'echo-links-create', type: 'knowledge', domainId: 'echo',
    createdAt: '', updatedAt: '', tags: ['echo', 'link', 'connect'],
    operationId: 'echo.links.create', displayName: 'Create Link',
    description: 'Creates a link between two items',
    category: 'links',
    parameters: [
      { name: 'sourceId', type: 'number', description: 'Source item ID', required: true },
      { name: 'targetId', type: 'number', description: 'Target item ID', required: true },
      { name: 'type', type: 'string', description: 'Link type', required: false, default: 'related' },
    ],
  },
  {
    id: 'echo-notify-send', type: 'knowledge', domainId: 'echo',
    createdAt: '', updatedAt: '', tags: ['echo', 'notify', 'send', 'message'],
    operationId: 'echo.notify.send', displayName: 'Send Notification',
    description: 'Sends a notification message',
    category: 'notifications',
    parameters: [
      { name: 'to', type: 'string', description: 'Recipient', required: true },
      { name: 'message', type: 'string', description: 'Message body', required: true },
      { name: 'channel', type: 'string', description: 'Notification channel', required: false, enum: ['email', 'sms', 'push'] },
    ],
  },
];

// Echo eval goals
export const ECHO_EVAL_GOALS = [
  { goal: 'Create a new item named "Test"', domainId: 'echo', complexity: 'simple' as const, expectedOps: ['echo.items.create'] },
  { goal: 'List all items', domainId: 'echo', complexity: 'simple' as const, expectedOps: ['echo.items.list'] },
  { goal: 'Create an item and then update its name', domainId: 'echo', complexity: 'medium' as const, expectedOps: ['echo.items.create', 'echo.items.update'] },
  { goal: 'Create two items and link them together', domainId: 'echo', complexity: 'medium' as const, expectedOps: ['echo.items.create', 'echo.items.create', 'echo.links.create'] },
  { goal: 'Create an item, send a notification about it, then delete it', domainId: 'echo', complexity: 'complex' as const, expectedOps: ['echo.items.create', 'echo.notify.send', 'echo.items.delete'] },
];
