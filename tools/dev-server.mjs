// Local development: serves the app and runs a private MQTT broker, so nothing touches public servers.
//   npm run dev           → http://localhost:8080/?broker=ws://localhost:8883
// Open that address in two browser windows to play as two phones.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, createWebSocketStream } from 'ws';
import aedes from 'aedes';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.md': 'text/markdown; charset=utf-8' };

export async function startDevServer({ httpPort = 8080, mqttPort = 8883, quiet = false } = {}) {
  const server = http.createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise(r => server.listen(httpPort, r));

  const broker = aedes();
  const wss = new WebSocketServer({ port: mqttPort, handleProtocols: p => (p.has('mqtt') ? 'mqtt' : false) });
  wss.on('connection', ws => broker.handle(createWebSocketStream(ws)));
  await new Promise(r => wss.on('listening', r));

  if (!quiet) console.log(`App:    http://localhost:${httpPort}/?broker=ws://localhost:${mqttPort}\nBroker: ws://localhost:${mqttPort}`);
  return {
    url: `http://localhost:${httpPort}/?broker=ws://localhost:${mqttPort}`,
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise(r => wss.close(r));
      await new Promise(r => broker.close(r));
      await new Promise(r => server.close(r));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startDevServer();
