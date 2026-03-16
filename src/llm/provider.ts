/**
 * LLM Provider Abstraction
 * Identical to n8n-a2e — same 4 providers, zero dependencies.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface LlmProvider {
  name: string;
  chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse>;
}

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

// ─── Anthropic Claude ────────────────────────────────────────────────────────

export class ClaudeProvider implements LlmProvider {
  name = 'claude';
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'claude-sonnet-4-20250514';
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
  }

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: nonSystem.map(m => ({ role: m.role, content: m.content })),
    };
    if (systemMsg) body.system = systemMsg.content;
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.stop) body.stop_sequences = options.stop;

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Claude API error (${res.status}): ${await res.text()}`);

    const data = await res.json() as any;
    return {
      content: data.content.map((c: any) => c.text).join(''),
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
      model: data.model,
    };
  }
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

export class OpenAiProvider implements LlmProvider {
  name = 'openai';
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gpt-4o';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
  }

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: options?.maxTokens ?? 4096,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.stop) body.stop = options.stop;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);

    const data = await res.json() as any;
    return {
      content: data.choices[0].message.content,
      usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens },
      model: data.model,
    };
  }
}

// ─── Ollama ──────────────────────────────────────────────────────────────────

export class OllamaProvider implements LlmProvider {
  name = 'ollama';
  private model: string;
  private baseUrl: string;

  constructor(config?: { model?: string; baseUrl?: string }) {
    this.model = config?.model ?? 'llama3.1';
    this.baseUrl = config?.baseUrl ?? 'http://localhost:11434';
  }

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      options: { temperature: options?.temperature ?? 0.7, num_predict: options?.maxTokens ?? 4096 },
    };
    if (options?.stop) (body.options as any).stop = options.stop;

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Ollama API error (${res.status}): ${await res.text()}`);

    const data = await res.json() as any;
    return {
      content: data.message.content,
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
      model: data.model,
    };
  }
}

// ─── Cloudflare Workers AI ──────────────────────────────────────────────────

export class CloudflareAiProvider implements LlmProvider {
  name = 'cloudflare';
  private apiKey: string;
  private accountId: string;
  private model: string;
  private gateway?: string;

  constructor(config: { apiKey: string; accountId: string; model?: string; gateway?: string }) {
    this.apiKey = config.apiKey;
    this.accountId = config.accountId;
    this.model = config.model ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    this.gateway = config.gateway;
  }

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const url = this.gateway
      ? `https://gateway.ai.cloudflare.com/v1/${this.accountId}/${this.gateway}/workers-ai/v1/chat/completions`
      : `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/v1/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: options?.maxTokens ?? 4096,
      stream: false,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.stop) body.stop = options.stop;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Cloudflare Workers AI error (${res.status}): ${await res.text()}`);

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? data.result?.response ?? '';
    return {
      content,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      model: this.model,
    };
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export type ProviderType = 'claude' | 'openai' | 'ollama' | 'cloudflare';

export function createProvider(type: ProviderType, config?: Record<string, unknown>): LlmProvider {
  switch (type) {
    case 'claude':
      return new ClaudeProvider({ apiKey: (config?.apiKey as string) || process.env.ANTHROPIC_API_KEY || '', model: config?.model as string });
    case 'openai':
      return new OpenAiProvider({ apiKey: (config?.apiKey as string) || process.env.OPENAI_API_KEY || '', model: config?.model as string });
    case 'ollama':
      return new OllamaProvider({ model: config?.model as string, baseUrl: config?.baseUrl as string });
    case 'cloudflare':
      return new CloudflareAiProvider({
        apiKey: (config?.apiKey as string) || process.env.CF_API_KEY || '',
        accountId: (config?.accountId as string) || process.env.CF_ACCOUNT_ID || '',
        model: config?.model as string,
        gateway: config?.gateway as string,
      });
    default:
      throw new Error(`Unknown provider: ${type}`);
  }
}
