// Minimal static server for tests (no dependencies). Extra in-memory routes
// can be injected, which is how the IWER test page exists without being a file.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream', '.glb': 'model/gltf-binary', '.png': 'image/png', '.md': 'text/markdown', '.svg': 'image/svg+xml' };

export function serve(root, { port = 0, extra = {} } = {}) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (extra[url]) {
      const [type, body] = extra[url];
      res.writeHead(200, { 'Content-Type': type });
      return res.end(body);
    }
    let p = path.join(root, url);
    if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
