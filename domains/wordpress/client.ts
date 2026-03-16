/**
 * WordPress REST API Client
 * Zero dependencies — uses native fetch.
 *
 * Adapted from wp-a2e for ctt-shell WordPress domain.
 */

export interface WpClientConfig {
  baseUrl: string;
  username?: string;
  applicationPassword?: string;
  token?: string;
  timeout?: number;
}

export interface WpApiResponse {
  success: boolean;
  status: number;
  data: unknown;
  error?: string;
}

export interface WpRouteSchema {
  namespace: string;
  methods: string[];
  endpoints: Array<{
    methods: string[];
    args: Record<string, WpArgSchema>;
  }>;
}

export interface WpArgSchema {
  type?: string | string[];
  description?: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
  context?: string[];
}

export interface WpDiscoveryResult {
  name: string;
  description: string;
  url: string;
  namespaces: string[];
  routes: Record<string, WpRouteSchema>;
}

export class WpClient {
  private baseUrl: string;
  private authHeader: string;
  private timeout: number;

  constructor(config: WpClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeout = config.timeout ?? 30000;

    if (config.token) {
      this.authHeader = `Bearer ${config.token}`;
    } else if (config.username && config.applicationPassword) {
      const credentials = Buffer.from(`${config.username}:${config.applicationPassword}`).toString('base64');
      this.authHeader = `Basic ${credentials}`;
    } else {
      this.authHeader = '';
    }
  }

  /** Make an authenticated request to the WordPress REST API */
  async request(method: string, endpoint: string, body?: unknown, params?: Record<string, string>): Promise<WpApiResponse> {
    let url = `${this.baseUrl}/wp-json${endpoint}`;

    if (params && Object.keys(params).length > 0) {
      url += '?' + new URLSearchParams(params).toString();
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) headers['Authorization'] = this.authHeader;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const contentType = res.headers.get('content-type') ?? '';
      const data = contentType.includes('application/json') ? await res.json() : await res.text();

      return res.ok
        ? { success: true, status: res.status, data }
        : { success: false, status: res.status, data, error: `HTTP ${res.status}` };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { success: false, status: 0, data: null, error: `Timeout after ${this.timeout}ms` };
      }
      return { success: false, status: 0, data: null, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Discover all REST API routes from the WordPress instance */
  async discover(): Promise<WpDiscoveryResult> {
    const res = await this.request('GET', '/');
    if (!res.success) {
      throw new Error(`WordPress REST API discovery failed: ${res.error}`);
    }
    const root = res.data as Record<string, unknown>;
    return {
      name: String(root.name ?? ''),
      description: String(root.description ?? ''),
      url: String(root.url ?? ''),
      namespaces: (root.namespaces as string[]) ?? [],
      routes: (root.routes as Record<string, WpRouteSchema>) ?? {},
    };
  }

  /** Check if the WordPress instance is reachable */
  async ping(): Promise<{ ok: boolean; name?: string; error?: string }> {
    try {
      const res = await this.request('GET', '/');
      if (res.success) {
        const data = res.data as Record<string, unknown>;
        return { ok: true, name: String(data.name ?? 'WordPress') };
      }
      return { ok: false, error: res.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
