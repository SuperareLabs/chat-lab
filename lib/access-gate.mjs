import { randomBytes, scrypt, scryptSync, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { problem } from './store.mjs';

const derive = promisify(scrypt);
const COOKIE = 'chat_lab_access';
const digest = token => createHash('sha256').update(token).digest('hex');

/** Authentication metadata lives in RAM; no visitor workspace is stored here. */
export function createAccessGate({ password, clock = () => Date.now(), ttlMs = 7 * 86400_000,
  maxSessions = 5000, maxAttempts = 8, attemptWindowMs = 60_000 } = {}) {
  if (typeof password !== 'string' || !password || password.length > 1024) {
    throw new Error('公开体验模式需要在服务器环境中设置 CHAT_ACCESS_PASSWORD');
  }
  const salt = randomBytes(16);
  const expected = scryptSync(password, salt, 32);
  const sessions = new Map();
  const attempts = new Map();
  let checking = 0;

  function cookie(token, secure, maxAge = Math.floor(ttlMs / 1000)) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }
  function tokenFor(request) {
    const matches = String(request.headers?.cookie ?? '').split(';').map(part => part.trim())
      .filter(part => part.startsWith(COOKIE + '='));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(COOKIE.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }
  function prune() {
    const now = clock();
    for (const [key, expires] of sessions) if (expires <= now) sessions.delete(key);
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
  }
  function authenticated(request) {
    const token = tokenFor(request);
    if (!token) return false;
    const key = digest(token), expires = sessions.get(key);
    if (!expires || expires <= clock()) { sessions.delete(key); return false; }
    return true;
  }
  function status(request) {
    return { authenticated: authenticated(request), passwordRequired: true, storageMode: 'browser' };
  }

  return {
    status,
    require(request) { if (!authenticated(request)) throw problem('请先输入进入密码', 401); },
    async login(request, value, { secure = false } = {}) {
      prune();
      const address = request.socket?.remoteAddress ?? 'unknown';
      const attempt = attempts.get(address);
      if (attempt?.count >= maxAttempts && attempt.until > clock()) {
        throw problem('尝试次数较多，请稍后再试', 429);
      }
      if (checking >= 4) throw problem('正在验证其他请求，请稍后再试', 429);
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).some(key => key !== 'password') || typeof value.password !== 'string' || value.password.length > 1024) {
        throw problem('请输入进入密码', 400);
      }
      checking++;
      let candidate;
      try { candidate = await derive(value.password, salt, 32); }
      finally { checking--; }
      if (!timingSafeEqual(expected, candidate)) {
        if (!attempts.has(address) && attempts.size >= 10_000) attempts.delete(attempts.keys().next().value);
        attempts.set(address, { count: (attempt?.count ?? 0) + 1, until: attempt?.until ?? clock() + attemptWindowMs });
        throw problem('密码不正确，请再试一次', 401);
      }
      attempts.delete(address);
      if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('base64url');
      sessions.set(digest(token), clock() + ttlMs);
      return { value: { authenticated: true, passwordRequired: true, storageMode: 'browser' },
        cookie: cookie(token, secure) };
    },
    logout(request, { secure = false } = {}) {
      const token = tokenFor(request);
      if (token) sessions.delete(digest(token));
      return { value: { authenticated: false, passwordRequired: true, storageMode: 'browser' },
        cookie: cookie('', secure, 0) };
    },
    close() { sessions.clear(); attempts.clear(); },
  };
}
