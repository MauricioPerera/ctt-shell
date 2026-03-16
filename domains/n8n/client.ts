/**
 * n8n REST API Client
 * Zero dependencies — uses native fetch.
 *
 * Adapted from n8n-a2e for ctt-shell n8n domain.
 */

export interface N8nClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
}

export interface N8nApiResponse {
  success: boolean;
  data: unknown;
  error?: string;
}

export interface N8nWorkflowPayload {
  name: string;
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    typeVersion: number;
    position: [number, number];
    parameters: Record<string, unknown>;
    credentials?: Record<string, { id: string; name: string }>;
    disabled?: boolean;
  }>;
  connections: Record<string, Record<string, Array<Array<{ node: string; type: string; index: number }>>>>;
  settings?: Record<string, unknown>;
  active?: boolean;
}

export class N8nClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(config: N8nClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30000;
  }

  /** Create a new workflow (starts inactive) */
  async createWorkflow(workflow: N8nWorkflowPayload): Promise<N8nApiResponse> {
    return this.request('POST', '/workflows', workflow);
  }

  /** Get a workflow by ID */
  async getWorkflow(id: string): Promise<N8nApiResponse> {
    return this.request('GET', `/workflows/${id}`);
  }

  /** List workflows */
  async listWorkflows(limit = 20): Promise<N8nApiResponse> {
    return this.request('GET', `/workflows?limit=${limit}`);
  }

  /** Update a workflow */
  async updateWorkflow(id: string, workflow: Partial<N8nWorkflowPayload>): Promise<N8nApiResponse> {
    return this.request('PUT', `/workflows/${id}`, workflow);
  }

  /** Delete a workflow */
  async deleteWorkflow(id: string): Promise<N8nApiResponse> {
    return this.request('DELETE', `/workflows/${id}`);
  }

  /** Activate a workflow */
  async activateWorkflow(id: string): Promise<N8nApiResponse> {
    return this.request('POST', `/workflows/${id}/activate`);
  }

  /** Deactivate a workflow */
  async deactivateWorkflow(id: string): Promise<N8nApiResponse> {
    return this.request('POST', `/workflows/${id}/deactivate`);
  }

  /** List executions for a workflow */
  async listExecutions(workflowId: string, limit = 10): Promise<N8nApiResponse> {
    return this.request('GET', `/executions?workflowId=${workflowId}&limit=${limit}`);
  }

  /** Get available node types from the instance */
  async getNodeTypes(): Promise<N8nApiResponse> {
    // n8n exposes node type descriptions at this endpoint
    try {
      const url = `${this.baseUrl}/types/nodes.json`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return { success: false, data: null, error: `HTTP ${res.status}` };
        const data = await res.json();
        return { success: true, data };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return { success: false, data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Check if n8n instance is reachable */
  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.request('GET', '/workflows?limit=1');
      return { ok: res.success };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<N8nApiResponse> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'X-N8N-API-KEY': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const contentType = res.headers.get('content-type') ?? '';
      const data = contentType.includes('application/json') ? await res.json() : await res.text();

      return res.ok
        ? { success: true, data }
        : { success: false, data, error: `HTTP ${res.status}` };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { success: false, data: null, error: `Timeout after ${this.timeout}ms` };
      }
      return { success: false, data: null, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
