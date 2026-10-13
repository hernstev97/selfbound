// TCP proxy with a fixed delay per direction, for the "remote" profile (P2).
//
// Chrome's network throttling does not delay WebSocket messages reliably. So everything the
// browser loads in profile P2 goes through this proxy: the static files and the Convex
// connection. Every chunk is held back by `delayMs`, order is preserved. The WebSocket upgrade
// passes through unchanged.
//
// Manual use: node perf/latency-proxy.ts 50 13590:13520 5592:5522

import net from 'node:net';

export interface ProxyHandle {
  close(): Promise<void>;
}

export function startProxy(listenPort: number, targetPort: number, delayMs: number, host = '127.0.0.1'): Promise<ProxyHandle> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect({ host, port: targetPort });
    for (const s of [client, upstream]) {
      s.setNoDelay(true);
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
    const pipe = (from: net.Socket, to: net.Socket) => {
      from.on('data', (chunk) => {
        setTimeout(() => {
          if (!to.destroyed) to.write(chunk);
        }, delayMs);
      });
      from.on('end', () => setTimeout(() => to.end(), delayMs));
    };
    pipe(client, upstream);
    pipe(upstream, client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, host, () =>
      resolve({
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [delay, ...mappings] = process.argv.slice(2);
  for (const mapping of mappings) {
    const [from, to] = mapping.split(':').map(Number);
    await startProxy(from, to, Number(delay));
    console.log(`127.0.0.1:${from} → 127.0.0.1:${to}, +${delay} ms per direction`);
  }
}
