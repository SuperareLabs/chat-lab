import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { readConfig } from './lib/config.mjs';
import { ChatStore, problem } from './lib/store.mjs';
import { ChatRuntime } from './lib/runtime.mjs';
import { createAccessGate } from './lib/access-gate.mjs';
import { createBrowserWorkspace, BROWSER_WORKSPACE_MAX_BYTES } from './lib/browser-workspace.mjs';
import { PublicCatalog } from './lib/public-catalog.mjs';
import { loadSharedPrompts } from './lib/shared-prompts.mjs';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
}

async function jsonBody(request, maxBytes = 64_000) {
  if (!/^application\/json\b/i.test(request.headers['content-type'] || '')) throw problem('请发送 JSON 请求', 415);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw problem('请求内容太长', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body');
    return body;
  } catch { throw problem('请求 JSON 无效'); }
}

function safeText(value, name, max, required = true) {
  if (!required && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || value.includes('\u0000')) {
    throw problem(name + '格式或长度无效');
  }
  return value.trim();
}

function chatInput(body) {
  if (body.messages === undefined) return [{ text: safeText(body.text, '消息', 4000) }];
  if (body.text !== undefined || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 40) {
    throw problem('请选择发送单条消息或 1–40 条连发消息');
  }
  const messages = body.messages.map(item => {
    const text = safeText(item?.text, '消息', 4000);
    const createdAt = item.createdAt;
    if (createdAt !== undefined && (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) ||
        new Date(createdAt).toISOString() !== createdAt)) {
      throw problem('消息时间格式无效');
    }
    return { text, createdAt };
  });
  if (messages.map(message => message.text).join('\n').length > 16_000) throw problem('连发消息总长度过长', 413);
  return messages;
}

function childInput(body) {
  const name = safeText(body.name, '姓名', 48);
  const age = body.age == null || body.age === '' ? null : Number(body.age);
  if (age !== null && ((typeof body.age !== 'string' && typeof body.age !== 'number') ||
      !Number.isInteger(age) || age < 1 || age > 120)) throw problem('年龄请填写 1–120 的整数或留空');
  const interests = body.interests ?? [];
  if (!Array.isArray(interests) || interests.length > 20) throw problem('兴趣须为最多 20 项的列表');
  return { name, age, interests: [...new Set(interests.map(item => safeText(item, '兴趣', 64)))] };
}

function isPrivateAddress(address) {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function validateOrigin(request, isApi, allowLan, publicOrigins = []) {
  const host = request.headers.host || '';
  if (!host || /[\s\/@\\?#]/.test(host)) throw problem('请求地址无效', 403);
  const candidates = publicOrigins.filter(value => {
    try {
      const expected = new URL(value);
      const actual = new URL(expected.protocol + '//' + host);
      return actual.host.toLowerCase() === expected.host.toLowerCase() && actual.pathname === '/';
    } catch { return false; }
  });
  const configured = candidates.find(value => value === request.headers.origin) || candidates[0];
  const match = /^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/i.exec(host);
  const hostname = match?.[1].toLowerCase();
  const localAddress = request.socket.localAddress;
  const port = match?.[2] ? Number(match[2]) : 80;
  const allowed = hostname === 'localhost' || hostname === '127.0.0.1' ||
    (allowLan && isPrivateAddress(hostname || '') && hostname === localAddress);
  if (!configured && (!allowed || port !== request.socket.localPort)) throw problem('请求地址不在本站允许的地址中', 403);
  const origin = configured || new URL(`http://${host}`).origin;
  if (isApi && request.headers.origin && request.headers.origin !== origin) throw problem('不接受来自其他网页的请求', 403);
  if (isApi && request.headers['sec-fetch-site'] === 'cross-site') throw problem('不接受跨站请求', 403);
  return origin;
}

async function serveStatic(response, method, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw problem('无效的页面路径'); }
  if (decoded.includes('\\') || decoded.split('/').some(part => part === '..' || part.startsWith('.'))) {
    throw problem('找不到页面', 404);
  }
  const relative = decoded === '/' ? 'index.html' : decoded.slice(1);
  const filename = resolve(PUBLIC, relative);
  const mime = TYPES[extname(filename).toLowerCase()];
  if (!filename.startsWith(resolve(PUBLIC) + sep) || !mime) throw problem('找不到页面', 404);
  let data;
  try { data = await readFile(filename); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') throw problem('找不到页面', 404);
    throw error;
  }
  response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
  response.end(method === 'HEAD' ? undefined : data);
}

export function createLabServer(options = {}) {
  const config = options.provider
    ? {
      dbPath: options.dbPath ?? ':memory:', timezone: 'Asia/Shanghai', port: 4333, host: '127.0.0.1',
      storageMode: 'server', publicOrigins: [],
      model: { name: '测试模型', configured: true, searchConfigured: !!options.search?.configured, mode: 'test' },
      ...options,
    }
    : { ...readConfig(options.env), ...options };
  const browserMode = config.storageMode === 'browser';
  if (config.localNoAuth && (config.host !== '127.0.0.1' ||
      config.publicOrigins.some(value => !['localhost', '127.0.0.1'].includes(new URL(value).hostname)))) {
    throw new Error('免登录模式仅限127.0.0.1监听和本机访问地址');
  }
  // Public mode never opens the legacy SQLite file, even if CHAT_DB_PATH is set.
  const store = browserMode ? null : new ChatStore(config.dbPath);
  const runtime = browserMode ? null : new ChatRuntime({ appVersion: APP_VERSION, ...config, store });
  const gate = browserMode && !config.localNoAuth ? createAccessGate({ password: config.accessPassword }) : null;
  if (browserMode && config.catalogPath && config.catalogPath !== ':memory:' && config.dbPath !== ':memory:' &&
      resolve(config.catalogPath) === resolve(config.dbPath)) throw new Error('公共角色库必须与旧聊天数据库使用不同文件');
  const catalog = browserMode ? config.catalog ?? new PublicCatalog({ path: config.catalogPath ?? ':memory:' }) : null;
  const defaults = browserMode && config.defaultAgents === undefined
    ? JSON.parse(readFileSync(new URL('./config/default-agents.json', import.meta.url), 'utf8')) : {};
  const defaultAgents = browserMode ? config.defaultAgents ?? defaults.agents : [];
  const retiredAgentIds = new Set(config.retiredAgentIds ?? defaults.retiredAgentIds ?? []);
  const sharedPrompts = browserMode ? config.sharedPrompts ?? loadSharedPrompts() : [];
  const browserWorkspace = browserMode ? createBrowserWorkspace({ ...config, appVersion: APP_VERSION,
    catalog, defaultAgents, retiredAgentIds: [...retiredAgentIds], sharedPrompts,
    defaultChildren: config.defaultChildren ?? [{ name: '访客', age: 22, interests: [] }],
  }) : null;
  const activeWorkspaces = new Set();
  const workspaceControllers = new Set();
  let accepting = true;
  const handler = async (request, response) => {
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    const origin = validateOrigin(request, pathname.startsWith('/api/'), config.host === '0.0.0.0', config.publicOrigins);
    const method = request.method;
    const secure = origin.startsWith('https:');
    if (method === 'GET' && pathname === '/api/auth/session') {
      return sendJson(response, 200, gate ? gate.status(request)
        : { authenticated: true, passwordRequired: false, storageMode: config.storageMode });
    }
    if (gate && pathname === '/api/auth/login' && method === 'POST') {
      const login = await gate.login(request, await jsonBody(request), { secure });
      return sendJson(response, 200, login.value, { 'Set-Cookie': login.cookie });
    }
    if (gate && pathname === '/api/auth/logout' && method === 'POST') {
      const logout = gate.logout(request, { secure });
      return sendJson(response, 200, logout.value, { 'Set-Cookie': logout.cookie });
    }
    if (browserMode && pathname.startsWith('/api/')) {
      gate?.require(request);
      if (!accepting) throw problem('服务正在重启，请稍后再试', 503);
      const ownerKey = request.headers['x-chat-lab-owner'];
      if (pathname === '/api/catalog' && method === 'GET') {
        if ([...searchParams.keys()].some(key => key !== 'revision') || searchParams.getAll('revision').length > 1) {
          throw problem('公共角色库地址参数无效');
        }
        if (ownerKey !== undefined && (typeof ownerKey !== 'string' || !/^[a-f0-9]{64}$/.test(ownerKey))) {
          throw problem('缺少有效的角色管理凭证', 403);
        }
        if (searchParams.has('revision')) {
          const supplied = searchParams.get('revision');
          if (!/^(0|[1-9]\d*)$/.test(supplied) || !Number.isSafeInteger(Number(supplied))) throw problem('公共角色库版本无效');
          const revision = catalog.currentRevision();
          if (Number(supplied) === revision) return sendJson(response, 200, { revision, unchanged: true });
        }
        return sendJson(response, 200, { ...catalog.list(ownerKey), defaultAgentIds: defaultAgents.filter(agent => !retiredAgentIds.has(agent.id)).map(agent => agent.id) });
      }
      if (pathname === '/api/catalog/agents' && method === 'POST') {
        return sendJson(response, 201, catalog.create(await jsonBody(request), { ownerKey }));
      }
      const publicAgent = /^\/api\/catalog\/agents\/([^/]+)$/.exec(pathname);
      if (publicAgent && ['PATCH', 'DELETE'].includes(method)) {
        let id;
        try { id = decodeURIComponent(publicAgent[1]); }
        catch { throw problem('找不到此公共角色', 404); }
        const body = await jsonBody(request);
        return sendJson(response, 200, method === 'PATCH' ? catalog.update(id, body, { ownerKey }) : catalog.delete(id, body, { ownerKey }));
      }
      // Do not expose old server-owned users, records or CRUD routes in public mode.
      if (pathname !== '/api/local' || method !== 'POST') throw problem('找不到此地址', 404);
      if (!accepting || activeWorkspaces.size >= 4) throw problem('当前服务较忙，请稍后再试', 503);
      const controller = new AbortController();
      workspaceControllers.add(controller);
      response.once('close', () => controller.abort());
      let finish;
      const activity = new Promise(resolveActivity => { finish = resolveActivity; });
      activeWorkspaces.add(activity);
      try {
        const envelope = await jsonBody(request, BROWSER_WORKSPACE_MAX_BYTES + 128 * 1024);
        const chat = envelope.method === 'POST' && envelope.path === '/api/chat';
        let streaming = false;
        const emit = chat ? event => {
          if (response.destroyed || response.writableEnded) return;
          if (!streaming) {
            streaming = true;
            response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
            response.flushHeaders();
          }
          response.write('data: ' + JSON.stringify(event) + '\n\n');
        } : undefined;
        try {
          const result = await browserWorkspace.execute(envelope, { emit, signal: controller.signal });
          if (!response.destroyed && !response.writableEnded) {
            if (streaming) response.end();
            else sendJson(response, result.status, result);
          }
        } catch (error) {
          if (!streaming) throw error;
          emit({ type: 'error', error: error.status ? error.message : '这次请求未能完成，请检查已保存的消息后再试' });
          if (!response.destroyed && !response.writableEnded) response.end();
        }
      } finally {
        activeWorkspaces.delete(activity);
        workspaceControllers.delete(controller);
        finish();
      }
      return;
    }
    const childId = searchParams.get('childId');
    const agentId = runtime?.agentId(searchParams.get('agentId'));

    if (method === 'GET' && pathname === '/api/state') {
      return sendJson(response, 200, runtime.state());
    }
    if (method === 'POST' && pathname === '/api/agents') {
      return sendJson(response, 201, { agent: runtime.createAgent(await jsonBody(request)) });
    }
    const agentRoute = /^\/api\/agents\/([^/]+)$/.exec(pathname);
    if (agentRoute && (method === 'GET' || method === 'PATCH')) {
      let id;
      try { id = decodeURIComponent(agentRoute[1]); }
      catch { throw problem('找不到此角色', 404); }
      return sendJson(response, 200, { agent: method === 'GET' ? runtime.agent(id)
        : runtime.updateAgent(id, await jsonBody(request)) });
    }
    const promptRoute = /^\/api\/agents\/([^/]+)\/prompt$/.exec(pathname);
    if (method === 'GET' && promptRoute) {
      let promptAgentId;
      try { promptAgentId = decodeURIComponent(promptRoute[1]); }
      catch { throw problem('找不到此角色', 404); }
      return sendJson(response, 200, runtime.promptDetail(promptAgentId));
    }
    if (method === 'POST' && pathname === '/api/children') {
      const child = store.createChild(childInput(await jsonBody(request)), runtime.now());
      return sendJson(response, 201, { child });
    }
    if (pathname === '/api/sessions') {
      if (method === 'GET') {
        runtime.assertScope(childId, agentId);
        runtime.tick();
        return sendJson(response, 200, { sessions: store.sessions(childId, agentId) });
      }
      if (method === 'POST') {
        const scope = await jsonBody(request);
        const selectedAgent = runtime.agentId(scope.agentId);
        runtime.assertScope(scope.childId, selectedAgent);
        runtime.assertAudience(scope.childId, selectedAgent);
        const session = store.manuallyOpen(scope.childId, selectedAgent, runtime.now());
        runtime.tick();
        return sendJson(response, 201, { session });
      }
    }
    if (method === 'GET' && pathname.startsWith('/api/sessions/')) {
      runtime.assertScope(childId, agentId);
      runtime.tick();
      const session = store.session(pathname.slice('/api/sessions/'.length), childId, agentId);
      if (!session) throw problem('找不到此会话', 404);
      return sendJson(response, 200, session);
    }
    if (method === 'GET' && pathname === '/api/memory') {
      runtime.assertScope(childId, agentId);
      runtime.tick();
      return sendJson(response, 200, {
        profile: store.profile(childId, agentId), overview: store.userOverview(childId, agentId),
        chatOverview: runtime.chatOverview(childId, agentId, { includeSources: true }),
        counts: store.memoryCounts(childId, agentId),
        items: store.allMemories(childId, agentId), jobs: store.jobList(childId, agentId),
      });
    }
    const retryMemoryRoute = /^\/api\/memory\/jobs\/([^/]+)\/retry$/.exec(pathname);
    if (method === 'POST' && retryMemoryRoute) {
      const scope = await jsonBody(request);
      const selectedAgent = runtime.agentId(scope.agentId);
      runtime.assertScope(scope.childId, selectedAgent);
      let sessionId;
      try { sessionId = decodeURIComponent(retryMemoryRoute[1]); }
      catch { throw problem('记忆任务 ID 无效'); }
      const job = store.retryJob(sessionId, scope.childId, selectedAgent, runtime.now());
      runtime.tick();
      return sendJson(response, 202, { job });
    }
    if (method === 'GET' && pathname.startsWith('/api/memory/')) {
      runtime.assertScope(childId, agentId);
      const item = store.memoryDetail(pathname.slice('/api/memory/'.length), childId, agentId, { includeRetracted: true });
      if (!item) throw problem('找不到此记忆', 404);
      return sendJson(response, 200, { item });
    }
    if (method === 'POST' && pathname === '/api/chat') {
      const body = await jsonBody(request);
      const args = {
        childId: body.childId, agentId: body.agentId,
        sessionId: safeText(body.sessionId, '会话 ID', 100, false),
        requestId: safeText(body.requestId, '请求 ID', 100),
        messages: chatInput(body),
      };
      const run = runtime.beginChat(args);
      response.writeHead(200, {
        ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      const controller = new AbortController();
      response.once('close', () => controller.abort());
      const emit = event => {
        if (!response.destroyed && !response.writableEnded) response.write('data: ' + JSON.stringify(event) + '\n\n');
      };
      try {
        await runtime.chat(run, emit, controller.signal);
      } finally {
        if (!response.destroyed && !response.writableEnded) response.end();
      }
      return;
    }
    if (pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(method)) throw problem('找不到此地址', 404);
    return serveStatic(response, method, pathname);
  };

  const server = createServer((request, response) => {
    handler(request, response).catch(error => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.end();
        return;
      }
      return sendJson(response, error.status || 500, { error: error.status ? error.message : '实验室服务暂时无法完成请求' });
    });
  });

  return {
    server, runtime, store, catalog, storageMode: config.storageMode, model: config.model,
    async listen(port = config.port) {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, config.host, () => {
          server.removeListener('error', reject);
          try {
            runtime?.initialize();
            resolveListen();
          } catch (error) {
            server.close(() => reject(error));
          }
        });
      });
      runtime?.tick();
      return server.address();
    },
    async close({ drain = false } = {}) {
      accepting = false;
      const closed = new Promise(resolveClose => server.close(resolveClose));
      if (!drain) for (const controller of workspaceControllers) controller.abort();
      await Promise.allSettled([...activeWorkspaces]);
      await runtime?.stop({ drain });
      await closed;
      store?.close();
      gate?.close();
      catalog?.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const lab = createLabServer();
    const { port } = await lab.listen();
    const state = lab.runtime ? lab.runtime.state() : { model: lab.model };
    process.stdout.write(`全Agent轻量聊天实验台 http://127.0.0.1:${port}（${state.model.configured ? state.model.name : '模型未配置'}）\n`);
    if (lab.server.address().address === '0.0.0.0') {
      const addresses = new Set(Object.values(networkInterfaces()).flat()
        .filter(item => item.family === 'IPv4' && !item.internal && isPrivateAddress(item.address)).map(item => item.address));
      for (const address of addresses) process.stdout.write(`局域网访问 http://${address}:${port}\n`);
    }
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await lab.close({ drain: true });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    process.stderr.write('实验室启动失败：' + error.message + '\n');
    process.exitCode = 1;
  }
}
