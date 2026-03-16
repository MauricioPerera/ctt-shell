/**
 * WordPress Domain Adapter — controls WordPress via REST API.
 *
 * Operations are WordPress REST API endpoints discovered from a live instance
 * or pre-loaded from built-in definitions.
 *
 * operationId format: "METHOD:/namespace/route" e.g. "POST:/wp/v2/posts"
 */

import type { DomainAdapter, PlanNormalizer } from '../../src/domain/adapter.js';
import type { Knowledge, ExecutionPlan, ExecutionResult, ExecutionStep, ValidationResult, StepResult } from '../../src/types/entities.js';
import { WpClient, type WpClientConfig, type WpArgSchema } from './client.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface WordPressAdapterConfig {
  /** WordPress instance URL */
  baseUrl?: string;
  /** WordPress username */
  username?: string;
  /** Application Password */
  applicationPassword?: string;
  /** JWT or bearer token */
  token?: string;
  /** Timeout per request */
  timeout?: number;
}

export class WordPressAdapter implements DomainAdapter {
  readonly id = 'wordpress';
  readonly name = 'WordPress (REST API)';
  private client: WpClient | null = null;
  private config: WordPressAdapterConfig;
  private discoveredKnowledge: Knowledge[] | null = null;

  constructor(config?: WordPressAdapterConfig) {
    this.config = config ?? {};
    if (config?.baseUrl) {
      this.client = new WpClient({
        baseUrl: config.baseUrl,
        username: config.username,
        applicationPassword: config.applicationPassword,
        token: config.token,
        timeout: config.timeout,
      });
    }
  }

  /** Connect to a WordPress instance (can be called after construction) */
  connect(config: WpClientConfig): void {
    this.client = new WpClient(config);
    this.config.baseUrl = config.baseUrl;
  }

  async extractKnowledge(): Promise<Knowledge[]> {
    // If connected to a live instance, discover endpoints dynamically
    if (this.client) {
      try {
        const discovery = await this.client.discover();
        this.discoveredKnowledge = this.parseDiscovery(discovery);
        return this.discoveredKnowledge;
      } catch {
        // Fall back to built-in knowledge
      }
    }
    return WP_BUILTIN_KNOWLEDGE;
  }

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    if (!this.client) {
      return {
        success: false,
        goal: plan.goal,
        domainId: 'wordpress',
        steps: [],
        totalDurationMs: 0,
        error: 'No WordPress instance configured. Set WP_BASE_URL, WP_USERNAME, WP_APP_PASSWORD.',
      };
    }

    const start = Date.now();
    const outputs = new Map<string, unknown>();
    const stepResults: StepResult[] = [];

    for (const step of plan.steps) {
      const stepStart = Date.now();
      const params = this.resolveRefs(step.params, outputs);
      const { method, endpoint } = this.parseOperationId(step.operationId);

      try {
        // Resolve path params: /wp/v2/posts/{id} → /wp/v2/posts/42
        const resolvedEndpoint = this.resolvePathParams(endpoint, params);

        // Separate path params from body/query params
        const pathParamNames = this.extractPathParamNames(endpoint);
        const bodyParams: Record<string, unknown> = {};
        const queryParams: Record<string, string> = {};

        for (const [key, value] of Object.entries(params)) {
          if (pathParamNames.has(key)) continue; // Already resolved in URL
          if (method === 'GET' || method === 'DELETE') {
            queryParams[key] = String(value);
          } else {
            bodyParams[key] = value;
          }
        }

        const response = await this.client.request(
          method,
          resolvedEndpoint,
          method !== 'GET' && method !== 'DELETE' ? bodyParams : undefined,
          Object.keys(queryParams).length > 0 ? queryParams : undefined,
        );

        // Handle idempotency errors (e.g., term_exists)
        let success = response.success;
        let responseData = response.data;
        if (!success && response.status === 400) {
          const err = response.data as Record<string, unknown>;
          if (err?.code === 'term_exists' && typeof err.data === 'object') {
            const termData = err.data as Record<string, unknown>;
            const recoveredId = termData?.term_id ?? termData?.resource_id;
            if (recoveredId) {
              success = true;
              responseData = { id: recoveredId, recovered: true };
            }
          }
        }

        if (step.outputRef && responseData !== undefined) {
          outputs.set(step.outputRef, responseData);
        }

        stepResults.push({
          stepId: step.stepId,
          operationId: step.operationId,
          success,
          response: responseData,
          error: success ? undefined : response.error,
          durationMs: Date.now() - stepStart,
        });

        if (!success) {
          return {
            success: false,
            goal: plan.goal,
            domainId: 'wordpress',
            steps: stepResults,
            totalDurationMs: Date.now() - start,
            error: `Step ${step.stepId} (${step.operationId}) failed: ${response.error}`,
          };
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        stepResults.push({
          stepId: step.stepId,
          operationId: step.operationId,
          success: false,
          error,
          durationMs: Date.now() - stepStart,
        });
        return {
          success: false,
          goal: plan.goal,
          domainId: 'wordpress',
          steps: stepResults,
          totalDurationMs: Date.now() - start,
          error,
        };
      }
    }

    return {
      success: true,
      goal: plan.goal,
      domainId: 'wordpress',
      steps: stepResults,
      totalDurationMs: Date.now() - start,
    };
  }

  validate(plan: ExecutionPlan): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const knowledge = this.discoveredKnowledge ?? WP_BUILTIN_KNOWLEDGE;
    const knownOps = new Set(knowledge.map(k => k.operationId));

    for (const step of plan.steps) {
      if (!knownOps.has(step.operationId)) {
        // Check if method:endpoint pattern is valid
        const { method, endpoint } = this.parseOperationId(step.operationId);
        if (!method || !endpoint) {
          errors.push(`Invalid operationId format: ${step.operationId} (expected "METHOD:/path")`);
        } else {
          warnings.push(`Unknown endpoint: ${step.operationId}`);
        }
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
      'post': ['article', 'blog', 'content', 'publish', 'draft'],
      'page': ['static', 'content', 'about', 'contact'],
      'category': ['taxonomy', 'term', 'group', 'classify'],
      'tag': ['taxonomy', 'term', 'label', 'keyword'],
      'media': ['image', 'upload', 'file', 'attachment', 'photo'],
      'user': ['author', 'admin', 'editor', 'subscriber'],
      'comment': ['reply', 'feedback', 'discussion'],
      'menu': ['navigation', 'nav', 'links'],
      'plugin': ['extension', 'addon', 'module'],
      'theme': ['template', 'design', 'layout', 'style'],
      'woocommerce': ['shop', 'ecommerce', 'product', 'order', 'cart'],
      'settings': ['option', 'config', 'configure'],
    };
  }

  planNormalizers(): PlanNormalizer[] {
    return [
      (plan, fixes) => {
        for (const step of plan.steps) {
          // Normalize operation IDs
          const opId = step.operationId;

          // Fix missing method prefix: "/wp/v2/posts" → "POST:/wp/v2/posts"
          if (opId.startsWith('/')) {
            const method = this.inferMethod(step);
            step.operationId = `${method}:${opId}`;
            fixes.push(`added method prefix: "${opId}" → "${step.operationId}"`);
          }

          // Fix PATCH/PUT → POST (WordPress uses POST for updates via /id endpoint)
          if (opId.startsWith('PATCH:') || opId.startsWith('PUT:')) {
            step.operationId = 'POST:' + opId.split(':').slice(1).join(':');
            fixes.push(`changed ${opId.split(':')[0]} → POST for WordPress compatibility`);
          }

          // Fix trailing /edit, /update, /delete suffixes
          if (step.operationId.match(/\/(edit|update)$/)) {
            step.operationId = step.operationId.replace(/\/(edit|update)$/, '');
            fixes.push('removed trailing /edit or /update suffix');
          }

          // Fix taxonomy category references: string names → {{ref.id}} arrays
          if (step.operationId.includes('/posts') || step.operationId.includes('/pages')) {
            for (const field of ['categories', 'tags']) {
              const val = step.params[field];
              if (typeof val === 'string' && !val.startsWith('{{')) {
                // LLM put a name instead of an ID ref — leave as warning
              }
              // Ensure arrays for taxonomy fields
              if (typeof val === 'number') {
                step.params[field] = [val];
                fixes.push(`wrapped ${field} number in array`);
              }
            }
          }

          // Fix WooCommerce taxonomy format: [id] → [{id: id}]
          if (step.operationId.includes('/wc/v3/')) {
            for (const field of ['categories', 'tags']) {
              const val = step.params[field];
              if (Array.isArray(val) && val.length > 0 && typeof val[0] !== 'object') {
                step.params[field] = val.map(v => ({ id: v }));
                fixes.push(`converted WC ${field} to object format`);
              }
            }
          }
        }
      },
    ];
  }

  /** Check if WordPress instance is reachable */
  async isAvailable(): Promise<boolean> {
    if (!this.client) return false;
    const { ok } = await this.client.ping();
    return ok;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private parseOperationId(opId: string): { method: HttpMethod; endpoint: string } {
    const colonIdx = opId.indexOf(':');
    if (colonIdx > 0 && colonIdx < 7) {
      return {
        method: opId.slice(0, colonIdx).toUpperCase() as HttpMethod,
        endpoint: opId.slice(colonIdx + 1),
      };
    }
    return { method: 'GET', endpoint: opId };
  }

  private inferMethod(step: ExecutionStep): HttpMethod {
    const desc = step.description?.toLowerCase() ?? '';
    if (desc.includes('create') || desc.includes('add') || desc.includes('new')) return 'POST';
    if (desc.includes('update') || desc.includes('edit') || desc.includes('modify')) return 'POST';
    if (desc.includes('delete') || desc.includes('remove')) return 'DELETE';
    if (desc.includes('list') || desc.includes('get') || desc.includes('fetch')) return 'GET';
    // If has body params, likely POST
    if (Object.keys(step.params).length > 1) return 'POST';
    return 'GET';
  }

  private resolvePathParams(endpoint: string, params: Record<string, unknown>): string {
    return endpoint.replace(/\{(\w+)\}/g, (_m, name) => {
      const value = params[name];
      return value !== undefined ? String(value) : `{${name}}`;
    });
  }

  private extractPathParamNames(endpoint: string): Set<string> {
    const names = new Set<string>();
    const matches = endpoint.matchAll(/\{(\w+)\}/g);
    for (const m of matches) names.add(m[1]);
    return names;
  }

  private resolveRefs(params: Record<string, unknown>, outputs: Map<string, unknown>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.includes('{{')) {
        resolved[key] = value.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_m, ref, field) => {
          const output = outputs.get(ref) as Record<string, unknown> | undefined;
          return output?.[field] !== undefined ? String(output[field]) : `{{${ref}.${field}}}`;
        });
      } else if (Array.isArray(value)) {
        resolved[key] = value.map(v => {
          if (typeof v === 'string' && v.includes('{{')) {
            return v.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_m, ref, field) => {
              const output = outputs.get(ref) as Record<string, unknown> | undefined;
              return output?.[field] !== undefined ? String(output[field]) : `{{${ref}.${field}}}`;
            });
          }
          if (typeof v === 'object' && v !== null) {
            return this.resolveRefs(v as Record<string, unknown>, outputs);
          }
          return v;
        });
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  private parseDiscovery(discovery: { routes: Record<string, { namespace: string; endpoints: Array<{ methods: string[]; args: Record<string, WpArgSchema> }> }> }): Knowledge[] {
    const knowledge: Knowledge[] = [];

    for (const [route, schema] of Object.entries(discovery.routes)) {
      if (route === '/' || route.startsWith('/oembed')) continue;

      for (const endpoint of schema.endpoints) {
        for (const method of endpoint.methods) {
          const routeClean = route.replace(/\(\?P<(\w+)>[^)]+\)/g, '{$1}').replace(/\/{2,}/g, '/');
          const category = this.categorizeRoute(route, schema.namespace);
          const dname = this.generateDisplayName(method as HttpMethod, route);
          const opId = `${method}:${routeClean}`;

          const params = Object.entries(endpoint.args).map(([name, arg]) => ({
            name,
            type: Array.isArray(arg.type) ? arg.type[0] : (arg.type ?? 'string'),
            description: arg.description ?? '',
            required: arg.required ?? false,
            enum: arg.enum,
            default: arg.default,
          }));

          knowledge.push({
            id: `wp-${method.toLowerCase()}-${routeClean.replace(/[^a-z0-9]/gi, '-')}`,
            type: 'knowledge',
            domainId: 'wordpress',
            createdAt: '',
            updatedAt: '',
            tags: [category, method.toLowerCase(), schema.namespace, 'wordpress'],
            operationId: opId,
            displayName: dname,
            description: `${method} ${routeClean} — ${category}`,
            category,
            parameters: params,
          });
        }
      }
    }
    return knowledge;
  }

  private categorizeRoute(route: string, namespace: string): string {
    if (namespace.startsWith('wc/')) return 'woocommerce';
    if (route.includes('/posts')) return 'posts';
    if (route.includes('/pages')) return 'pages';
    if (route.includes('/media')) return 'media';
    if (route.includes('/categories') || route.includes('/tags') || route.includes('/taxonomies')) return 'taxonomy';
    if (route.includes('/users')) return 'users';
    if (route.includes('/comments')) return 'comments';
    if (route.includes('/settings')) return 'settings';
    if (route.includes('/plugins')) return 'plugins';
    if (route.includes('/themes')) return 'themes';
    if (route.includes('/menus') || route.includes('/menu-items')) return 'menus';
    if (route.includes('/blocks') || route.includes('/block')) return 'blocks';
    if (route.includes('/search')) return 'search';
    return 'other';
  }

  private generateDisplayName(method: HttpMethod, route: string): string {
    const resource = route
      .replace(/^\/wp\/v2\//, '').replace(/^\/wc\/v3\//, '')
      .replace(/\(\?P<[^>]+>[^)]+\)/g, '')
      .replace(/\/{2,}/g, '/').replace(/\/$/, '')
      .split('/').filter(Boolean);

    const last = resource[resource.length - 1] ?? 'resource';
    const hasId = route.includes('(?P<id>') || route.includes('(?P<parent>');
    const verb = { GET: hasId ? 'Get' : 'List', POST: 'Create', PUT: 'Update', PATCH: 'Update', DELETE: 'Delete' }[method] ?? method;
    return `${verb} ${last.charAt(0).toUpperCase() + last.slice(1)}`;
  }
}

// ─── Built-in WordPress Knowledge ────────────────────────────────────────────
// Core endpoints available on any standard WordPress installation.

const WP_BUILTIN_KNOWLEDGE: Knowledge[] = [
  // Posts
  {
    id: 'wp-list-posts', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['posts', 'get', 'wp/v2', 'wordpress'],
    operationId: 'GET:/wp/v2/posts', displayName: 'List Posts',
    description: 'GET /wp/v2/posts — Retrieve a list of posts with optional filters.',
    category: 'posts',
    parameters: [
      { name: 'per_page', type: 'integer', description: 'Number of posts per page', required: false, default: 10 },
      { name: 'page', type: 'integer', description: 'Page number', required: false },
      { name: 'status', type: 'string', description: 'Post status (publish, draft, etc.)', required: false },
      { name: 'categories', type: 'array', description: 'Category IDs to filter by', required: false },
      { name: 'tags', type: 'array', description: 'Tag IDs to filter by', required: false },
      { name: 'search', type: 'string', description: 'Search term', required: false },
    ],
  },
  {
    id: 'wp-create-post', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['posts', 'post', 'wp/v2', 'wordpress', 'create'],
    operationId: 'POST:/wp/v2/posts', displayName: 'Create Post',
    description: 'POST /wp/v2/posts — Create a new blog post.',
    category: 'posts',
    parameters: [
      { name: 'title', type: 'string', description: 'Post title', required: true },
      { name: 'content', type: 'string', description: 'Post content (HTML)', required: false },
      { name: 'status', type: 'string', description: 'Post status', required: false, default: 'draft', enum: ['publish', 'draft', 'pending', 'private'] },
      { name: 'categories', type: 'array', description: 'Category IDs', required: false },
      { name: 'tags', type: 'array', description: 'Tag IDs', required: false },
      { name: 'featured_media', type: 'integer', description: 'Featured image ID', required: false },
    ],
  },
  {
    id: 'wp-get-post', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['posts', 'get', 'wp/v2', 'wordpress'],
    operationId: 'GET:/wp/v2/posts/{id}', displayName: 'Get Post',
    description: 'GET /wp/v2/posts/{id} — Retrieve a single post by ID.',
    category: 'posts',
    parameters: [
      { name: 'id', type: 'integer', description: 'Post ID', required: true },
    ],
  },
  {
    id: 'wp-update-post', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['posts', 'post', 'wp/v2', 'wordpress', 'update'],
    operationId: 'POST:/wp/v2/posts/{id}', displayName: 'Update Post',
    description: 'POST /wp/v2/posts/{id} — Update an existing post.',
    category: 'posts',
    parameters: [
      { name: 'id', type: 'integer', description: 'Post ID', required: true },
      { name: 'title', type: 'string', description: 'Post title', required: false },
      { name: 'content', type: 'string', description: 'Post content', required: false },
      { name: 'status', type: 'string', description: 'Post status', required: false },
      { name: 'categories', type: 'array', description: 'Category IDs', required: false },
      { name: 'tags', type: 'array', description: 'Tag IDs', required: false },
    ],
  },
  {
    id: 'wp-delete-post', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['posts', 'delete', 'wp/v2', 'wordpress'],
    operationId: 'DELETE:/wp/v2/posts/{id}', displayName: 'Delete Post',
    description: 'DELETE /wp/v2/posts/{id} — Delete a post (move to trash).',
    category: 'posts',
    parameters: [
      { name: 'id', type: 'integer', description: 'Post ID', required: true },
      { name: 'force', type: 'boolean', description: 'Skip trash, permanent delete', required: false },
    ],
  },

  // Pages
  {
    id: 'wp-list-pages', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['pages', 'get', 'wp/v2', 'wordpress'],
    operationId: 'GET:/wp/v2/pages', displayName: 'List Pages',
    description: 'GET /wp/v2/pages — Retrieve a list of pages.',
    category: 'pages',
    parameters: [
      { name: 'per_page', type: 'integer', description: 'Number per page', required: false },
      { name: 'status', type: 'string', description: 'Page status', required: false },
      { name: 'parent', type: 'integer', description: 'Parent page ID', required: false },
    ],
  },
  {
    id: 'wp-create-page', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['pages', 'post', 'wp/v2', 'wordpress', 'create'],
    operationId: 'POST:/wp/v2/pages', displayName: 'Create Page',
    description: 'POST /wp/v2/pages — Create a new page.',
    category: 'pages',
    parameters: [
      { name: 'title', type: 'string', description: 'Page title', required: true },
      { name: 'content', type: 'string', description: 'Page content (HTML)', required: false },
      { name: 'status', type: 'string', description: 'Page status', required: false, default: 'draft' },
      { name: 'parent', type: 'integer', description: 'Parent page ID (for child pages)', required: false },
    ],
  },
  {
    id: 'wp-update-page', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['pages', 'post', 'wp/v2', 'wordpress', 'update'],
    operationId: 'POST:/wp/v2/pages/{id}', displayName: 'Update Page',
    description: 'POST /wp/v2/pages/{id} — Update an existing page.',
    category: 'pages',
    parameters: [
      { name: 'id', type: 'integer', description: 'Page ID', required: true },
      { name: 'title', type: 'string', description: 'Page title', required: false },
      { name: 'content', type: 'string', description: 'Page content', required: false },
      { name: 'status', type: 'string', description: 'Page status', required: false },
    ],
  },

  // Categories
  {
    id: 'wp-list-categories', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['taxonomy', 'get', 'wp/v2', 'wordpress', 'category'],
    operationId: 'GET:/wp/v2/categories', displayName: 'List Categories',
    description: 'GET /wp/v2/categories — Retrieve categories.',
    category: 'taxonomy',
    parameters: [
      { name: 'per_page', type: 'integer', description: 'Number per page', required: false },
      { name: 'search', type: 'string', description: 'Search term', required: false },
      { name: 'parent', type: 'integer', description: 'Parent category ID', required: false },
    ],
  },
  {
    id: 'wp-create-category', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['taxonomy', 'post', 'wp/v2', 'wordpress', 'category', 'create'],
    operationId: 'POST:/wp/v2/categories', displayName: 'Create Category',
    description: 'POST /wp/v2/categories — Create a new category.',
    category: 'taxonomy',
    parameters: [
      { name: 'name', type: 'string', description: 'Category name', required: true },
      { name: 'description', type: 'string', description: 'Category description', required: false },
      { name: 'parent', type: 'integer', description: 'Parent category ID', required: false },
    ],
  },

  // Tags
  {
    id: 'wp-list-tags', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['taxonomy', 'get', 'wp/v2', 'wordpress', 'tag'],
    operationId: 'GET:/wp/v2/tags', displayName: 'List Tags',
    description: 'GET /wp/v2/tags — Retrieve tags.',
    category: 'taxonomy',
    parameters: [
      { name: 'per_page', type: 'integer', description: 'Number per page', required: false },
      { name: 'search', type: 'string', description: 'Search term', required: false },
    ],
  },
  {
    id: 'wp-create-tag', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['taxonomy', 'post', 'wp/v2', 'wordpress', 'tag', 'create'],
    operationId: 'POST:/wp/v2/tags', displayName: 'Create Tag',
    description: 'POST /wp/v2/tags — Create a new tag.',
    category: 'taxonomy',
    parameters: [
      { name: 'name', type: 'string', description: 'Tag name', required: true },
      { name: 'description', type: 'string', description: 'Tag description', required: false },
    ],
  },

  // Media
  {
    id: 'wp-list-media', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['media', 'get', 'wp/v2', 'wordpress'],
    operationId: 'GET:/wp/v2/media', displayName: 'List Media',
    description: 'GET /wp/v2/media — Retrieve media items.',
    category: 'media',
    parameters: [
      { name: 'per_page', type: 'integer', description: 'Number per page', required: false },
      { name: 'media_type', type: 'string', description: 'Filter by media type', required: false },
    ],
  },

  // Users
  {
    id: 'wp-list-users', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['users', 'get', 'wp/v2', 'wordpress'],
    operationId: 'GET:/wp/v2/users', displayName: 'List Users',
    description: 'GET /wp/v2/users — Retrieve users.',
    category: 'users',
    parameters: [
      { name: 'per_page', type: 'integer', description: 'Number per page', required: false },
      { name: 'roles', type: 'string', description: 'Filter by role', required: false },
    ],
  },

  // Comments
  {
    id: 'wp-list-comments', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['comments', 'get', 'wp/v2', 'wordpress'],
    operationId: 'GET:/wp/v2/comments', displayName: 'List Comments',
    description: 'GET /wp/v2/comments — Retrieve comments.',
    category: 'comments',
    parameters: [
      { name: 'post', type: 'integer', description: 'Post ID to filter by', required: false },
      { name: 'per_page', type: 'integer', description: 'Number per page', required: false },
    ],
  },
  {
    id: 'wp-create-comment', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['comments', 'post', 'wp/v2', 'wordpress', 'create'],
    operationId: 'POST:/wp/v2/comments', displayName: 'Create Comment',
    description: 'POST /wp/v2/comments — Create a comment.',
    category: 'comments',
    parameters: [
      { name: 'post', type: 'integer', description: 'Post ID', required: true },
      { name: 'content', type: 'string', description: 'Comment content', required: true },
      { name: 'author_name', type: 'string', description: 'Commenter name', required: false },
      { name: 'author_email', type: 'string', description: 'Commenter email', required: false },
    ],
  },

  // Settings
  {
    id: 'wp-get-settings', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['settings', 'get', 'wp/v2', 'wordpress'],
    operationId: 'GET:/wp/v2/settings', displayName: 'Get Settings',
    description: 'GET /wp/v2/settings — Retrieve site settings.',
    category: 'settings',
    parameters: [],
  },

  // WooCommerce (basic)
  {
    id: 'wp-wc-list-products', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['woocommerce', 'get', 'wc/v3', 'wordpress', 'product'],
    operationId: 'GET:/wc/v3/products', displayName: 'List Products',
    description: 'GET /wc/v3/products — Retrieve WooCommerce products.',
    category: 'woocommerce',
    parameters: [
      { name: 'per_page', type: 'integer', description: 'Number per page', required: false },
      { name: 'category', type: 'string', description: 'Category ID', required: false },
    ],
  },
  {
    id: 'wp-wc-create-product', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['woocommerce', 'post', 'wc/v3', 'wordpress', 'product', 'create'],
    operationId: 'POST:/wc/v3/products', displayName: 'Create Product',
    description: 'POST /wc/v3/products — Create a WooCommerce product.',
    category: 'woocommerce',
    parameters: [
      { name: 'name', type: 'string', description: 'Product name', required: true },
      { name: 'type', type: 'string', description: 'Product type', required: false, default: 'simple' },
      { name: 'regular_price', type: 'string', description: 'Regular price', required: false },
      { name: 'description', type: 'string', description: 'Product description', required: false },
      { name: 'categories', type: 'array', description: 'Category objects [{id: N}]', required: false },
    ],
  },
  {
    id: 'wp-wc-create-product-category', type: 'knowledge', domainId: 'wordpress',
    createdAt: '', updatedAt: '', tags: ['woocommerce', 'post', 'wc/v3', 'wordpress', 'category', 'create'],
    operationId: 'POST:/wc/v3/products/categories', displayName: 'Create Product Category',
    description: 'POST /wc/v3/products/categories — Create a WooCommerce product category.',
    category: 'woocommerce',
    parameters: [
      { name: 'name', type: 'string', description: 'Category name', required: true },
      { name: 'description', type: 'string', description: 'Category description', required: false },
    ],
  },
];

// ─── Eval Goals ──────────────────────────────────────────────────────────────

export const WP_EVAL_GOALS = [
  // Simple (1 step)
  {
    goal: 'Create a draft blog post titled "Hello from AI" about artificial intelligence',
    domainId: 'wordpress', complexity: 'simple' as const,
    expectedOps: ['POST:/wp/v2/posts'],
  },
  {
    goal: 'List all published posts on the site',
    domainId: 'wordpress', complexity: 'simple' as const,
    expectedOps: ['GET:/wp/v2/posts'],
  },
  {
    goal: 'Create a category called "News"',
    domainId: 'wordpress', complexity: 'simple' as const,
    expectedOps: ['POST:/wp/v2/categories'],
  },

  // Medium (2-3 steps)
  {
    goal: 'Create a category called "Technology" and then create a published post in that category about cloud computing',
    domainId: 'wordpress', complexity: 'medium' as const,
    expectedOps: ['POST:/wp/v2/categories', 'POST:/wp/v2/posts'],
  },
  {
    goal: 'Create a page titled "Contact" as draft, then update it to published status',
    domainId: 'wordpress', complexity: 'medium' as const,
    expectedOps: ['POST:/wp/v2/pages', 'POST:/wp/v2/pages/{id}'],
  },

  // Complex (3+ steps)
  {
    goal: 'Create a category "Tutorials", create a tag "beginner", then create a published post titled "Getting Started" in that category with that tag',
    domainId: 'wordpress', complexity: 'complex' as const,
    expectedOps: ['POST:/wp/v2/categories', 'POST:/wp/v2/tags', 'POST:/wp/v2/posts'],
  },
];
