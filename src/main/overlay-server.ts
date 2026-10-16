import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { ChatService } from './chat-service';

/**
 * Read-only local presentation server. There are intentionally no control, config,
 * transcript or filesystem APIs. In dev, only Vite's development asset paths proxy.
 */
export class OverlayServer {
  private server: Server | null = null;
  private sockets: WebSocketServer | null = null;
  private address: string | null = null;

  constructor(
    private readonly chat: ChatService,
    private readonly rendererDirectory: string,
    private readonly developmentOrigin?: string,
  ) {}

  get url(): string {
    if (!this.address) throw new Error('Overlay server is not running');
    return `${this.address}/overlay`;
  }

  async start(port = 0): Promise<string> {
    if (this.server) throw new Error('Overlay server is already running');
    const server = createServer((req, res) => {
      void this.respond(req, res);
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
    this.server = server;
    this.sockets = sockets;
    server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/overlay/live' || !this.allowedOrigin(req.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(req, socket, head, (client) => {
        sockets.emit('connection', client);
      });
    });
    sockets.on('connection', (client: WebSocket) => {
      // Subscribe before snapshot, on the same event loop turn, to prevent lost updates.
      const unsubscribe = this.chat.subscribe((event) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
      });
      client.once('close', unsubscribe);
      client.once('error', () => client.close());
      client.send(JSON.stringify(this.chat.snapshot()));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Invalid listener address');
      this.address = `http://127.0.0.1:${address.port}`;
      return this.url;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private allowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true; // non-browser consumers are also read-only
    return origin === this.address;
  }

  private async respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/overlay') {
      await this.sendFileOrProxy('/index.html', res, req.method);
      return;
    }
    // The renderer build contains only public UI assets; prohibit arbitrary files.
    if (pathname.startsWith('/assets/') && !pathname.includes('..') && !pathname.includes('\\')) {
      await this.sendFileOrProxy(pathname, res, req.method);
      return;
    }
    if (
      this.developmentOrigin &&
      (pathname.startsWith('/src/') ||
        pathname.startsWith('/@vite/') ||
        pathname.startsWith('/@react-refresh') ||
        pathname.startsWith('/node_modules/.vite/') ||
        pathname.startsWith('/node_modules/.pnpm/'))
    ) {
      await this.proxy(pathname, res, req.method);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }

  private async sendFileOrProxy(
    filePath: string,
    res: ServerResponse,
    method: string,
  ): Promise<void> {
    if (this.developmentOrigin) {
      await this.proxy(filePath, res, method);
      return;
    }
    const absolute = path.join(this.rendererDirectory, filePath);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) throw new Error('Not a file');
      const content = await readFile(absolute);
      const mime = filePath.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : filePath.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : filePath.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : filePath.endsWith('.svg')
              ? 'image/svg+xml'
              : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': String(content.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
      });
      res.end(method === 'HEAD' ? undefined : content);
    } catch {
      res.writeHead(404).end();
    }
  }

  private async proxy(filePath: string, res: ServerResponse, method: string): Promise<void> {
    try {
      const response = await fetch(new URL(filePath, this.developmentOrigin));
      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(502).end('Development renderer unavailable');
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    const sockets = this.sockets;
    this.server = null;
    this.sockets = null;
    this.address = null;
    if (sockets) {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    }
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
