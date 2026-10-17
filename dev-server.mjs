import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const apiBase = 'https://kaamsetu.phala.work/api';
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

const readBody = request => new Promise((resolve, reject) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => resolve(Buffer.concat(chunks)));
  request.on('error', reject);
});

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);

    if (requestUrl.pathname.startsWith('/api/')) {
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBody(request);
      const upstream = await fetch(`${apiBase}${requestUrl.pathname.slice(4)}${requestUrl.search}`, {
        method: request.method,
        headers: {
          'content-type': request.headers['content-type'] || 'application/json',
          'ngrok-skip-browser-warning': 'true'
        },
        body
      });
      response.statusCode = upstream.status;
      response.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    const requested = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
    const filePath = normalize(join(root, requested));
    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    const content = await readFile(filePath);
    response.statusCode = 200;
    response.setHeader('content-type', mime[extname(filePath)] || 'application/octet-stream');
    response.end(content);
  } catch (error) {
    response.statusCode = error.code === 'ENOENT' ? 404 : 502;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(error.code === 'ENOENT' ? 'Not found' : 'Proxy error');
  }
});

server.listen(port, () => {
  console.log(`KaamSetu frontend: http://localhost:${port}`);
  console.log(`API proxy: /api/* -> ${apiBase}`);
});
