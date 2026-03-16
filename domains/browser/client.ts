/**
 * PinchTab HTTP Client — controls Chrome via CDP.
 * Zero dependencies, uses native fetch.
 *
 * Adapted from wp-a2e for ctt-shell browser domain.
 */

export interface PinchTabConfig {
  baseUrl?: string;  // default: http://127.0.0.1:9867
  timeout?: number;  // ms, default: 30000
}

export interface PinchTabResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export type ActionType =
  | 'click' | 'type' | 'fill' | 'press' | 'hover'
  | 'scroll' | 'select' | 'focus' | 'drag';

export class PinchTabClient {
  private baseUrl: string;
  private timeout: number;

  constructor(config?: PinchTabConfig) {
    this.baseUrl = (config?.baseUrl ?? 'http://127.0.0.1:9867').replace(/\/+$/, '');
    this.timeout = config?.timeout ?? 30000;
  }

  async ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const res = await this.fetch('GET', '/health');
      if (res.success) {
        const data = res.data as Record<string, unknown>;
        return { ok: true, version: String(data?.version ?? 'unknown') };
      }
      return { ok: false, error: res.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Navigation
  async navigate(url: string, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<PinchTabResponse> {
    return this.fetch('POST', '/navigate', { url, waitUntil: waitUntil ?? 'load' });
  }
  async back(): Promise<PinchTabResponse> { return this.fetch('POST', '/back'); }
  async forward(): Promise<PinchTabResponse> { return this.fetch('POST', '/forward'); }
  async reload(): Promise<PinchTabResponse> { return this.fetch('POST', '/reload'); }

  // Page analysis
  async snapshot(): Promise<PinchTabResponse> { return this.fetch('GET', '/snapshot'); }
  async text(): Promise<PinchTabResponse> { return this.fetch('GET', '/text'); }
  async find(query: string): Promise<PinchTabResponse> { return this.fetch('POST', '/find', { query }); }
  async screenshot(options?: { fullPage?: boolean; selector?: string }): Promise<PinchTabResponse> {
    const params: Record<string, string> = {};
    if (options?.fullPage) params.fullPage = 'true';
    if (options?.selector) params.selector = options.selector;
    return this.fetch('GET', '/screenshot', undefined, params);
  }

  // Interactions
  async action(type: ActionType, ref: string, value?: string): Promise<PinchTabResponse> {
    const body: Record<string, unknown> = { type, ref };
    if (value !== undefined) body.value = value;
    return this.fetch('POST', '/action', body);
  }
  async click(ref: string): Promise<PinchTabResponse> { return this.action('click', ref); }
  async type(ref: string, text: string): Promise<PinchTabResponse> { return this.action('type', ref, text); }
  async fill(ref: string, text: string): Promise<PinchTabResponse> { return this.action('fill', ref, text); }
  async select(ref: string, value: string): Promise<PinchTabResponse> { return this.action('select', ref, value); }
  async press(key: string): Promise<PinchTabResponse> { return this.action('press', '', key); }
  async scroll(direction: 'up' | 'down', ref?: string): Promise<PinchTabResponse> { return this.action('scroll', ref ?? '', direction); }
  async actions(batch: Array<{ type: ActionType; ref: string; value?: string }>): Promise<PinchTabResponse> {
    return this.fetch('POST', '/actions', { actions: batch });
  }

  // Tabs
  async listTabs(): Promise<PinchTabResponse> { return this.fetch('GET', '/tabs'); }
  async newTab(url?: string): Promise<PinchTabResponse> { return this.fetch('POST', '/tab', url ? { url } : undefined); }
  async closeTab(tabId: string): Promise<PinchTabResponse> { return this.fetch('POST', `/tabs/${tabId}/close`); }

  // JavaScript eval
  async evaluate(expression: string): Promise<PinchTabResponse> { return this.fetch('POST', '/evaluate', { expression }); }

  // Core HTTP
  private async fetch(method: string, path: string, body?: unknown, params?: Record<string, string>): Promise<PinchTabResponse> {
    let url = `${this.baseUrl}${path}`;
    if (params && Object.keys(params).length > 0) {
      url += '?' + new URLSearchParams(params).toString();
    }
    const headers: Record<string, string> = {};
    if (body) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await globalThis.fetch(url, {
        method, headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const contentType = res.headers.get('content-type') ?? '';
      const data = contentType.includes('application/json') ? await res.json() : await res.text();
      return res.ok ? { success: true, data } : { success: false, error: `HTTP ${res.status}`, data };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { success: false, error: `Timeout after ${this.timeout}ms` };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
