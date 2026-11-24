import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider } from './provider.mjs';
import { createSearchAdapter, DEFAULT_SEARCH_MODEL } from './search.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function readCredentialFile(file) {
  if (!isAbsolute(file)) throw new Error('ARK_API_KEY_FILE 须为外部凭据文件的绝对路径');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const path = relative(realpathSync(root), realpathSync(file));
    if (!path.startsWith('../') && path !== '..' && !isAbsolute(path)) {
      throw new Error('凭据文件须存放在本项目目录外');
    }
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 8192 || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new Error('凭据文件须归当前用户所有，使用 0600 或 0400 权限');
    }
    const raw = readFileSync(fd, 'utf8').trim();
    const value = raw.match(/^(?:export\s+)?ARK_API_KEY\s*=\s*(.*?)$/)?.[1] ?? raw;
    const key = value.replace(/^(['"])(.*)\1$/, '$2');
    if (!key || /\s/.test(key)) throw new Error('外部凭据文件应只含 ARK_API_KEY 或一行密钥');
    return key;
  } finally {
    closeSync(fd);
  }
}

export function readConfig(env = process.env) {
  const apiKey = env.ARK_API_KEY?.trim() || (env.ARK_API_KEY_FILE ? readCredentialFile(env.ARK_API_KEY_FILE) : '');
  const baseUrl = new URL(env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3');
  if (baseUrl.username || baseUrl.password || baseUrl.hash || baseUrl.search ||
      (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)))) {
    throw new Error('ARK_BASE_URL 必须是 HTTPS 地址或本机 HTTP 地址，且不得包含凭据');
  }
  const ark = baseUrl.hostname === 'ark.cn-beijing.volces.com';
  const name = env.ARK_MODEL?.trim() || 'deepseek-v4-1-flash-economy-261017';
  const endpoint = env.ARK_ENDPOINT?.trim() || name;
  const memoryName = env.ARK_MEMORY_MODEL?.trim();
  const memoryEndpoint = env.ARK_MEMORY_ENDPOINT?.trim();
  const memoryModelName = memoryName || name;
  const thinking = env.ARK_THINKING || 'disabled';
  const reasoningEffort = env.ARK_REASONING_EFFORT || undefined;
  if (!['enabled', 'disabled'].includes(thinking)) throw new Error('ARK_THINKING 须为 enabled 或 disabled');
  if (reasoningEffort !== undefined && !['low', 'high', 'max'].includes(reasoningEffort)) throw new Error('ARK_REASONING_EFFORT 须为 low、high 或 max');
  const provider = createProvider({ apiKey, endpoint, model: name, baseUrl: baseUrl.href, ark });
  const memoryProvider = memoryName || memoryEndpoint
    ? createProvider({ apiKey, endpoint: memoryEndpoint || memoryModelName, model: memoryModelName, baseUrl: baseUrl.href, ark })
    : provider;
  const searchEndpoint = env.ARK_SEARCH_ENDPOINT?.trim() || DEFAULT_SEARCH_MODEL;
  const searchConfigured = !!apiKey && ark && env.ARK_SEARCH_ENABLED === '1';
  const dbPath = env.CHAT_DB_PATH ? resolve(env.CHAT_DB_PATH) : fileURLToPath(new URL('../data/chat.sqlite', import.meta.url));
  const catalogPath = env.CHAT_CATALOG_PATH === ':memory:' ? ':memory:' : env.CHAT_CATALOG_PATH
    ? resolve(env.CHAT_CATALOG_PATH) : fileURLToPath(new URL('../data/public-catalog.sqlite', import.meta.url));
  const port = Number(env.PORT || 4333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535');
  const host = env.CHAT_HOST?.trim() || '0.0.0.0';
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('CHAT_HOST 须为 127.0.0.1 或 0.0.0.0');
  const timezone = env.CHAT_TIMEZONE || 'Asia/Shanghai';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  const storageMode = env.CHAT_STORAGE_MODE || 'browser';
  if (!['browser', 'server'].includes(storageMode)) throw new Error('CHAT_STORAGE_MODE 须为 browser 或 server');
  const publicOrigins = (env.CHAT_PUBLIC_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
    const origin = new URL(value);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash ||
        (origin.pathname !== '/' && origin.pathname !== '')) throw new Error('CHAT_PUBLIC_ORIGIN 须为完整 HTTP(S) origin，不能包含路径');
    return origin.origin;
  });
  return {
    dbPath, catalogPath, port, host, timezone,
    storageMode, publicOrigins, accessPassword: env.CHAT_ACCESS_PASSWORD, localNoAuth: env.CHAT_LOCAL_NO_AUTH === '1',
    serviceClanTokenFile: env.CHAT_SERVICE_CLAN_TOKEN_FILE,
    jevRelay: env.CHAT_JEV_RELAY === 'chengdu-singapore',
    characterMediaDirectory: env.CHAT_CHARACTER_MEDIA_DIR,
    contextBriefEnabled: env.CHAT_CONTEXT_BRIEF === '1',
    allowDataReset: env.CHAT_ALLOW_DATA_RESET !== '0',
    model: { name, configured: !!apiKey, searchConfigured, searchModel: searchConfigured ? searchEndpoint : null, mode: apiKey ? 'provider' : 'unconfigured', thinking, ...(thinking === 'enabled' && reasoningEffort ? { reasoningEffort } : {}) },
    provider,
    memoryModel: { name: memoryModelName, configured: !!apiKey, mode: apiKey ? 'provider' : 'unconfigured' },
    memoryProvider,
    search: searchConfigured ? createSearchAdapter({ apiKey, endpoint: searchEndpoint }) : null,
  };
}
