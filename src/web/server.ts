/**
 * Web Server for CTT-Shell
 *
 * Serves a single-page UI and REST API endpoints.
 * Zero runtime dependencies — uses only Node.js built-in `http` module.
 *
 * Usage: `ctt-shell web [--port 3700]`
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../storage/store.js';
import { SearchEngine } from '../search/tfidf.js';
import { DomainRegistry } from '../domain/registry.js';
import { ContextLoader } from '../context/loader.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { EchoAdapter } from '../../domains/echo/adapter.js';
import { BrowserAdapter } from '../../domains/browser/index.js';
import { WordPressAdapter } from '../../domains/wordpress/index.js';
import { N8nAdapter } from '../../domains/n8n/index.js';
import { WpCliAdapter } from '../../domains/wp-cli/index.js';
import { GitAdapter } from '../../domains/git/index.js';
import { EmailAdapter } from '../../domains/email/index.js';
import { handleApiRoute } from './routes.js';
import type { Infra } from './routes.js';

// ─── Infrastructure Setup ────────────────────────────────────────────────────

const CTT_ROOT = join(process.cwd(), '.ctt-shell');
const STORE_ROOT = join(CTT_ROOT, 'store');

function createInfra(): Infra {
  const store = new Store({ root: STORE_ROOT });
  const search = new SearchEngine();
  const domains = new DomainRegistry(store, search);

  domains.register(new EchoAdapter());
  domains.register(new BrowserAdapter());
  domains.register(new WordPressAdapter());
  domains.register(new N8nAdapter());
  domains.register(new WpCliAdapter());
  domains.register(new GitAdapter());
  domains.register(new EmailAdapter());
  domains.rebuildIndex();

  // Auto-load user context
  const contextLoader = new ContextLoader(store, search);
  const contextDir = join(CTT_ROOT, 'context');
  contextLoader.loadDirectory(contextDir);
  contextLoader.rebuildIndex();

  const scheduler = new Scheduler(CTT_ROOT);

  return { store, search, domains, contextLoader, scheduler };
}

// ─── Static File Resolution ──────────────────────────────────────────────────

function resolveStaticDir(): string {
  // When running from compiled dist/, the static files are copied to dist/src/web/static/
  // When running via ts-node or similar, they're at src/web/static/
  const currentDir = typeof import.meta.url !== 'undefined'
    ? join(fileURLToPath(import.meta.url), '..')
    : __dirname;

  const candidates = [
    join(currentDir, 'static'),           // dist/src/web/static (compiled)
    join(currentDir, '..', '..', '..', 'src', 'web', 'static'),  // from dist/ back to src/
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }

  return candidates[0]; // fallback
}

// ─── Web Server ──────────────────────────────────────────────────────────────

export interface WebServerConfig {
  port?: number;          // default: 3700
  host?: string;          // default: '127.0.0.1' (local only for security)
}

export class WebServer {
  private infra: Infra;
  private indexHtml: string;

  constructor(infra?: Infra) {
    this.infra = infra ?? createInfra();

    // Load the HTML file
    const staticDir = resolveStaticDir();
    const htmlPath = join(staticDir, 'index.html');
    try {
      this.indexHtml = readFileSync(htmlPath, 'utf-8');
    } catch {
      this.indexHtml = '<html><body><h1>CTT-Shell</h1><p>UI file not found. Run build with copy step.</p></body></html>';
    }
  }

  /** Get the infrastructure (for testing) */
  getInfra(): Infra { return this.infra; }

  /** Handle a single HTTP request (public for testing) */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Static routes
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.indexHtml);
      return;
    }

    // API routes
    if (path.startsWith('/api/')) {
      await handleApiRoute(req, res, path, this.infra);
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /** Start listening on the given port */
  start(config?: WebServerConfig): ReturnType<typeof createServer> {
    const port = config?.port ?? parseInt(process.env.CTT_WEB_PORT || '3700', 10);
    const host = config?.host ?? '127.0.0.1';

    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch(err => {
        console.error('Request error:', err);
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    server.listen(port, host, () => {
      console.log(`CTT-Shell Web UI: http://${host}:${port}`);
      console.log('Press Ctrl+C to stop.');
    });

    return server;
  }
}

/** Start web server (called from CLI) */
export async function startWebServer(port?: number): Promise<void> {
  const server = new WebServer();
  server.start({ port });
  // Keep process alive
  await new Promise(() => {});
}
