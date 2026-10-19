import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Scriptable local HTTP server for connector tests. Serves synthetic data only. */
export class FeedServer {
  private server: Server;
  readonly hits: Array<{ path: string; headers: IncomingMessage['headers'] }> = [];
  private routes = new Map<string, Handler>();
  port = 0;

  constructor() {
    this.server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      this.hits.push({ path, headers: req.headers });
      const h = this.routes.get(path);
      if (!h) { res.statusCode = 404; res.end('not found'); return; }
      h(req, res);
    });
  }
  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  url(path: string) { return `http://127.0.0.1:${this.port}${path}`; }
  route(path: string, h: Handler) { this.routes.set(path, h); return this; }
  /** Serves XML with an ETag and answers 304 to a matching If-None-Match. */
  xml(path: string, body: () => string, etag?: () => string) {
    return this.route(path, (req, res) => {
      const tag = etag?.();
      if (tag && req.headers['if-none-match'] === tag) { res.statusCode = 304; res.end(); return; }
      res.setHeader('content-type', 'application/rss+xml; charset=utf-8');
      if (tag) res.setHeader('etag', tag);
      res.end(body());
    });
  }
  hitsFor(path: string) { return this.hits.filter((h) => h.path === path).length; }
  close() { this.server.closeAllConnections(); return new Promise<void>((r) => this.server.close(() => r())); }
}

export function rss(items: Array<{ title: string; link?: string; description?: string; pubDate?: string; content?: string }>, title = 'Synthetic Daily') {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${title}</title><language>id</language>
  ${items.map((i) => `<item><title>${esc(i.title)}</title>${i.link ? `<link>${esc(i.link)}</link>` : ''}${i.description ? `<description>${esc(i.description)}</description>` : ''}${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ''}${i.content ? `<content:encoded>${esc(i.content)}</content:encoded>` : ''}</item>`).join('')}
  </channel></rss>`;
}
