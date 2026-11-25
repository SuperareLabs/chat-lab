import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';

const askpass = fileURLToPath(new URL('../scripts/jev-ssh-askpass.mjs', import.meta.url));
const openRouter = 'openrouter.ai';
const relayConnectTimeoutMs = 1000;

function relayError(cause) {
  return Object.assign(new Error('成都 → 新加坡隧道不可用', { cause }), { code: 'SSH_RELAY_UNAVAILABLE' });
}

function relayAgent(socketPath) {
  const agent = new Agent({ keepAlive: true, maxSockets: 4 });
  agent.createConnection = ({ hostname }, callback) => {
    const authority = `${hostname}:443`;
    const connect = httpRequest({ socketPath, agent: false, method: 'CONNECT', path: authority, headers: { Host: authority },
      signal: AbortSignal.timeout(relayConnectTimeoutMs) });
    connect.once('error', error => callback(relayError(error)));
    connect.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback(relayError());
        return;
      }
      if (head.length) socket.unshift(head);
      callback(null, tlsConnect({ socket, servername: hostname, rejectUnauthorized: true }));
    });
    connect.end();
  };
  return agent;
}

function requestThroughRelay(agent, url, { method = 'GET', headers, body, signal }) {
  const outgoingHeaders = new Headers(headers);
  if (body != null && !outgoingHeaders.has('Content-Length')) outgoingHeaders.set('Content-Length', Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { agent, method, signal, headers: Object.fromEntries(outgoingHeaders) }, response => {
      try {
        const status = response.statusCode;
        const empty = method === 'HEAD' || response.headers['content-length'] === '0' || status === 204 || status === 205 || status === 304;
        if (empty) response.resume();
        resolve(new Response(empty ? null : Readable.toWeb(response), { status, headers: response.headers }));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.once('error', reject);
    request.end(body);
  });
}

function relayURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('Unexpected relay destination');
  return url;
}

async function readDecision(response) {
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      if ((size += chunk.length) > 256 * 1024) throw new Error('Jev response too large');
      chunks.push(chunk);
    }
  }
  return { status: response.status, ok: response.ok, json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

export function createJevRelay({ tokenFile }) {
  let current = null;
  let retry = null;
  let closed = false;

  function reconnect() {
    if (!closed && !retry) retry = setTimeout(() => { retry = null; start(); }, 15_000).unref();
  }

  function start() {
    if (closed || current || retry) return;
    let directory;
    try { directory = mkdtempSync('/tmp/chatlab-jev-'); }
    catch { reconnect(); return; }
    const socketPath = join(directory, 'connect.sock');
    const agent = relayAgent(socketPath);
    const child = spawn('/usr/bin/ssh', ['-N', '-T', '-F', '/dev/null',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${join(homedir(), '.ssh', 'known_hosts')}`,
      '-o', 'ConnectTimeout=4', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=2', '-o', 'NumberOfPasswordPrompts=1', '-o', 'PreferredAuthentications=password',
      '-o', 'PubkeyAuthentication=no', '-L', `${socketPath}:127.0.0.1:18443`, 'root@8.137.116.27'], {
      stdio: 'ignore', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: homedir(),
        SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', CHAT_SERVICE_CLAN_TOKEN_FILE: tokenFile },
    });
    const instance = { child, agent, ready: false };
    current = instance;
    child.once('error', () => { instance.ready = false; });
    instance.finished = new Promise(resolve => child.once('close', () => {
      if (current === instance) current = null;
      agent.destroy();
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* A later launch uses a fresh directory. */ }
      reconnect();
      resolve();
    }));
    const deadline = AbortSignal.timeout(5000);
    void (async () => {
      while (!closed && current === instance && !deadline.aborted) {
        if (statSync(socketPath, { throwIfNoEntry: false })?.isSocket()) {
          instance.ready = true;
          return;
        }
        await delay(40, undefined, { ref: false });
      }
      child.kill();
    })().catch(() => child.kill());
  }

  function available() {
    return !!(current?.ready && current.child.exitCode === null && current.child.signalCode === null);
  }

  return {
    start, available,
    async request(value, options) {
      if (!available()) throw relayError();
      const url = relayURL(value);
      if (url.hostname !== openRouter) throw new Error('Unexpected Jev relay destination');
      return readDecision(await requestThroughRelay(current.agent, url, { ...options, method: 'POST' }));
    },
    pikaFetch(value, options = {}) {
      if (!available()) throw relayError();
      const url = relayURL(value);
      const { hostname } = url;
      if (hostname !== 'pika.art' && !hostname.endsWith('.pika.art') &&
          !(options.method === 'PUT' && hostname.endsWith('.r2.cloudflarestorage.com'))) {
        throw new Error('Unexpected Pika relay destination');
      }
      return requestThroughRelay(current.agent, url, options);
    },
    async close() {
      closed = true;
      clearTimeout(retry);
      const instance = current;
      instance?.child.kill();
      await instance?.finished;
    },
  };
}
