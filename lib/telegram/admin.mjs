import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createAccessGate } from '../access-gate.mjs';
import { problem } from '../store.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
].map(([path, [file, mime]]) => [path, { mime, data: readFileSync(new URL(`../../public/telegram-admin/${file}`, import.meta.url)) }]));
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
function send(response, status, value, extra = {}) {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!/^application\/json\b/i.test(request.headers['content-type'] || '')) throw problem('请发送JSON请求', 415);
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 8192) throw problem('请求过长', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw problem('请求格式无效'); }
}

export function createTelegramAdmin({ database, password, origin, getBotState, applyPolicy }) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('管理页origin无效');
  const gate = createAccessGate({ password });
  const server = createServer(async (request, response) => {
    try {
      const local = `http://127.0.0.1:${server.address()?.port}`;
      const hosts = new Map([[base.host, base.origin], [new URL(local).host, local], [`localhost:${server.address()?.port}`, `http://localhost:${server.address()?.port}`]]);
      const expected = hosts.get(request.headers.host);
      if (!expected) throw problem('管理入口地址无效', 403);
      const path = new URL(request.url, expected).pathname;
      if (request.method === 'GET') {
        const asset = assets.get(path);
        if (asset) { response.writeHead(200, { ...headers, 'Content-Type': asset.mime }); response.end(asset.data); return; }
        if (path === '/api/auth') { send(response, 200, { authenticated: gate.status(request).authenticated }); return; }
        gate.require(request);
        if (path === '/api/state') { send(response, 200, { ...database.adminSnapshot(), bot: getBotState() }); return; }
        throw problem('找不到页面', 404);
      }
      if (request.method !== 'POST') throw problem('不支持此操作', 405);
      if (request.headers.origin !== expected || request.headers['sec-fetch-site'] === 'cross-site' || request.headers['x-chatlab-admin'] !== '1') throw problem('不接受跨站操作', 403);
      if (path === '/api/login') {
        const result = await gate.login(request, await body(request), { secure: base.protocol === 'https:' });
        send(response, 200, { authenticated: true }, { 'Set-Cookie': result.cookie }); return;
      }
      gate.require(request);
      if (path === '/api/logout') {
        const result = gate.logout(request, { secure: base.protocol === 'https:' });
        send(response, 200, { authenticated: false }, { 'Set-Cookie': result.cookie }); return;
      }
      if (path === '/api/access') {
        const input = await body(request);
        if (!input || Object.keys(input).some(k => !['publicAccess','allowedUserIds','revision'].includes(k))) throw problem('访问配置字段无效');
        const policy = database.saveAccessPolicy(input); applyPolicy(policy);
        send(response, 200, database.adminSnapshot()); return;
      }
      throw problem('找不到接口', 404);
    } catch (error) {
      if (!response.headersSent) send(response, error.status || 500, { error: error.status ? error.message : '管理服务暂时不可用' });
      else response.end();
    }
  });
  return { server,
    async listen(port, host = '0.0.0.0') { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); return server.address(); },
    async close() { await new Promise(resolve => server.close(resolve)); gate.close(); },
  };
}
