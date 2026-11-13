import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReferenceImage } from '../lib/reference-images.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchAdapter } from '../lib/search.mjs';
import { createLabServer } from '../server.mjs';
import { ChatStore } from '../lib/store.mjs';
import { memoryRequestFor } from '../lib/memory.mjs';

const reference = overrides => ({
  imageUrl: 'https://images.unsplash.com/photo-123?fit=crop&w=640',
  sourceUrl: 'https://www.nasa.gov/science/',
  title: '网上参考图',
  ...overrides,
});

test('normalizes a public HTTPS image and HTTP(S) source without creating an ID', () => {
  assert.deepEqual(normalizeReferenceImage(reference({
    imageUrl: 'HTTPS://IMAGES.UNSPLASH.COM.:443/a/../photo.jpg',
    sourceUrl: 'http://WWW.NASA.GOV:80/science/',
    width: 640, height: 480, id: 'untrusted', type: 'different', extra: true,
  })), {
    type: 'reference_image', imageUrl: 'https://images.unsplash.com/photo.jpg',
    sourceUrl: 'http://www.nasa.gov/science/', title: '网上参考图', width: 640, height: 480,
  });
});

test('accepts IDNA domain names and ordinary nondefault HTTPS ports', () => {
  const value = normalizeReferenceImage(reference({ imageUrl: 'https://图片.中国:8443/参考图.jpg' }));
  assert.equal(new URL(value.imageUrl).hostname, 'xn--wcsw84d.xn--fiqs8s');
  assert.equal(new URL(value.imageUrl).port, '8443');
  assert.equal(value.sourceUrl, reference().sourceUrl);
});

test('rejects missing, malformed, relative, unsupported and credential-bearing URLs', () => {
  for (const value of [undefined, null, 12, {}, [], '', '/image.jpg', '//images.unsplash.com/image.jpg',
    'not a URL', 'data:image/png;base64,YQ==', 'javascript:alert(1)', 'base64:YQ==',
    'file:///tmp/image.png', 'ftp://images.unsplash.com/image.jpg',
    'https://user:secret@images.unsplash.com/image.jpg', 'https://user@images.unsplash.com/image.jpg',
    'https://@images.unsplash.com/image.jpg', 'https://images.unsplash.com:99999/image.jpg',
    'https://images.unsplash.com\\@localhost/image.jpg',
    'https://images.unsplash.com/\nimage.jpg', ' https://images.unsplash.com/image.jpg']) {
    assert.equal(normalizeReferenceImage(reference({ imageUrl: value })), null, 'image ' + String(value));
    assert.equal(normalizeReferenceImage(reference({ sourceUrl: value })), null, 'source ' + String(value));
  }
  assert.equal(normalizeReferenceImage(reference({ imageUrl: 'http://images.unsplash.com/image.jpg' })), null);
});

test('rejects all IP literals, including normalized numeric IPv4 forms and IPv6', () => {
  for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1',
    '8.8.8.8', '0.0.0.0', '255.255.255.255', '127.1', '2130706433', '0x7f000001',
    '0177.0.0.1', '0x7f.0.0.1', '127.0.0.1.', '１２７.０.０.１',
    '[::1]', '[::]', '[2001:4860:4860::8888]', '[::ffff:127.0.0.1]']) {
    for (const key of ['imageUrl', 'sourceUrl']) {
      assert.equal(normalizeReferenceImage(reference({ [key]: 'https://' + host + '/image.jpg' })), null, key + ' ' + host);
    }
  }
});

test('rejects single-label, special-use and internal domains after URL normalization', () => {
  for (const host of ['localhost', 'LOCALHOST.', 'image.localhost', 'image.local', 'image.internal',
    'image.localdomain', 'image.localnet', 'image.home', 'image.lan', 'image.corp', 'image.mail',
    'image.intranet', 'image.private', 'image.test', 'image.invalid', 'image.example',
    'image.onion', 'image.alt', 'image.arpa', 'image.home.arpa',
    'intranet', '%6c%6f%63%61%6c%68%6f%73%74', 'image.%6c%6f%63%61%6c',
    '-image.nasa.gov', 'image-.nasa.gov', 'image..nasa.gov', 'image.nasa.gov..',
    'a'.repeat(64) + '.gov', Array(5).fill('a'.repeat(60)).join('.') + '.gov']) {
    for (const key of ['imageUrl', 'sourceUrl']) {
      assert.equal(normalizeReferenceImage(reference({ [key]: 'https://' + host + '/image.jpg' })), null, key + ' ' + host);
    }
  }
  assert.notEqual(normalizeReferenceImage(reference({ imageUrl: 'https://notlocalhost.nasa.gov/image.jpg' })), null);
  for (const host of ['example.com', 'img.example.com', 'example.net', 'img.example.net', 'example.org', 'img.example.org']) {
    assert.notEqual(normalizeReferenceImage(reference({ imageUrl: 'https://' + host + '/image.jpg' })), null);
  }
});

test('enforces the URL bound both before and after URL percent-encoding', () => {
  const prefix = 'https://images.unsplash.com/';
  const boundary = prefix + 'a'.repeat(2048 - prefix.length);
  assert.equal(normalizeReferenceImage(reference({ imageUrl: boundary })).imageUrl.length, 2048);
  assert.equal(normalizeReferenceImage(reference({ imageUrl: boundary + 'a' })), null);
  assert.equal(normalizeReferenceImage(reference({ sourceUrl: boundary + 'a' })), null);
  const encodedTooLong = prefix + '图'.repeat(300);
  assert(encodedTooLong.length < 2048);
  assert.equal(normalizeReferenceImage(reference({ imageUrl: encodedTooLong })), null);
});

test('bounds and cleans the title, omits invalid optional dimensions, and preserves the input', () => {
  const input = reference({ title: '  一张\n\t参考图\u0000  ', width: 640, height: 0 });
  const before = structuredClone(input);
  assert.deepEqual(normalizeReferenceImage(input), {
    type: 'reference_image', imageUrl: input.imageUrl, sourceUrl: input.sourceUrl,
    title: '一张 参考图', width: 640,
  });
  assert.deepEqual(input, before);
  for (const invalid of [0, -1, 1.5, '640', true, false, {}, null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const normalized = normalizeReferenceImage(reference({ width: invalid, height: invalid, title: null }));
    assert.equal(normalized.title, '');
    assert(!Object.hasOwn(normalized, 'width'));
    assert(!Object.hasOwn(normalized, 'height'));
  }
  assert.equal(normalizeReferenceImage(reference({ title: '字'.repeat(200) })).title.length, 180);
  const emojiBoundary = normalizeReferenceImage(reference({ title: '字'.repeat(179) + '🦎结束' })).title;
  assert.equal(emojiBoundary, '字'.repeat(179));
  assert.equal(normalizeReferenceImage(reference({ width: 1, height: Number.MAX_SAFE_INTEGER })).height, Number.MAX_SAFE_INTEGER);
});

test('does not fetch any URL and safely rejects non-object inputs', () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('Reference normalization must be offline'); };
  try {
    assert.notEqual(normalizeReferenceImage(reference()), null);
    assert.equal(normalizeReferenceImage(reference({ imageUrl: 'https://127.0.0.1/a.jpg' })), null);
    for (const input of [undefined, null, false, 42, 'image', []]) assert.equal(normalizeReferenceImage(input), null);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

const sourceUrl = 'https://www.nasa.gov/science/mars/';
const imageUrl = 'https://images.nasa.gov/mars.jpg';
const at = '2026-11-13T04:00:00.000Z';
const citation = overrides => ({ type: 'url_citation', title: '火星参考资料', url: sourceUrl,
  summary: '关于火星的公开资料。', cover_image: { url: imageUrl, width: 800, height: 600 }, ...overrides });
const arkPayload = annotations => ({ id: 'mock-response', model: 'doubao-seed-2-0-mini-260428', status: 'completed',
  output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', role: 'assistant', content: [
    { type: 'output_text', text: '{"imageUrl":"https://images.nasa.gov/made-up.jpg"}', annotations },
  ] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } });

test('search maps only official citation cover_image when requested, preserving its source page', async () => {
  let fetches = 0;
  const search = createSearchAdapter({ apiKey: 'test-only', fetchImpl: async () => {
    fetches++; return Response.json(arkPayload([citation()]));
  } });
  assert.equal((await search.search({ query: '火星参考图' })).results[0].cover_image, undefined);
  const found = await search.search({ query: '火星参考图', includeImage: true });
  assert.deepEqual(found.results[0].cover_image, { url: imageUrl, width: 800, height: 600 });
  assert.equal(found.results[0].url, sourceUrl);
  assert.equal(found.metadata.provenance, 'provider_url_citation');
  assert.equal(fetches, 2, 'one existing search request per invocation; images are never fetched');
});

test('missing, invalid and logo-only annotations degrade to cited text without invented image URLs', async () => {
  for (const extra of [{ cover_image: undefined, site_logo: { url: imageUrl } },
    { cover_image: { url: 'http://images.nasa.gov/insecure.jpg' } },
    { cover_image: { url: 'https://127.0.0.1/private.jpg' } },
    { cover_image: { url: 'https://images.local/private.jpg' } }]) {
    let requests = 0;
    const search = createSearchAdapter({ apiKey: 'test-only', fetchImpl: async () => {
      requests++; return Response.json(arkPayload([citation(extra)]));
    } });
    const found = await search.search({ query: '火星参考图', includeImage: true });
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].cover_image, undefined);
    assert.equal(requests, 1, 'no fallback search or image request');
  }
});

function mockResult({ cover = imageUrl, noCover = false, trusted = true } = {}) {
  return { metadata: { retrieved_at: at, ...(trusted ? { provenance: 'provider_url_citation' } : {}) }, results: [
    { title: '火星参考资料', url: sourceUrl, snippet: '火星表面有含铁矿物。',
      ...(!noCover ? { cover_image: { url: cover, width: 800, height: 600 } } : {}) },
    { title: '另一张配图', url: 'https://www.nasa.gov/science/mars-more/',
      cover_image: { url: 'https://images.nasa.gov/second.jpg' } },
  ].slice(0, noCover || cover !== imageUrl ? 1 : 2) };
}
const responseText = content => ({ content, toolCalls: [], receipt: { finish_reason: 'stop' } });
const searchResponse = includeImage => ({ content: '我查一下。', receipt: { finish_reason: 'tool_calls' }, toolCalls: [
  { id: 'search-with-optional-image', type: 'function', function: { name: 'search_web', arguments: JSON.stringify({
    query: '火星表面外观', ...(includeImage !== undefined ? { includeImage } : {}),
  }) } },
] });
async function imageLab(t, { dbPath = ':memory:', includeImage = true, omitImageFlag = false, result = mockResult(),
  failSearch = false, final = () => responseText('火星表面呈红褐色。') } = {}) {
  const counts = { model: 0, search: 0 };
  const lab = createLabServer({ dbPath, clock: () => new Date(at), contextBriefEnabled: false,
    allowDataReset: false, memoryModel: { name: 'disabled', configured: false },
    provider: { async chat(options) {
      counts.model++;
      assert(!JSON.stringify(options.messages).includes('https://images.nasa.gov/'), 'image URLs stay outside model messages');
      if (options.messages.at(-1).role === 'tool') return final(options);
      if (options.messages.at(-1).content === '看火星') return searchResponse(omitImageFlag ? undefined : includeImage);
      return responseText('继续聊。');
    } }, search: { configured: true, async search(options) {
      counts.search++;
      assert.equal(options.includeImage, omitImageFlag ? false : includeImage);
      if (failSearch) throw new Error('mock failure');
      return result;
    } } });
  const { port } = await lab.listen(0);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await lab.close(); } };
  t.after(close);
  const origin = 'http://127.0.0.1:' + port;
  const state = lab.runtime.state();
  const scope = { childId: state.children[0].id, agentId: state.agents[0].id };
  const chat = async (text = '看火星', requestId = crypto.randomUUID(), selected = scope) => {
    const response = await fetch(origin + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selected, text, requestId }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return (await response.text()).split('\n\n').filter(block => block.startsWith('data: '))
      .map(block => JSON.parse(block.slice(6)));
  };
  return { lab, counts, scope, origin, chat, close };
}

test('requested image is persisted once, replayed without new costs, and omitted from text and extraction', async t => {
  const f = await imageLab(t);
  const events = await f.chat('看火星', 'image-replay');
  const event = events.find(item => item.type === 'reply_attachment');
  assert(event);
  assert.equal(events.filter(item => item.type === 'reply_attachment').length, 1);
  assert.equal(event.attachment.type, 'reference_image');
  assert.equal(event.attachment.imageUrl, imageUrl);
  assert.equal(event.attachment.sourceUrl, sourceUrl);
  assert(events.findIndex(item => item.type === 'reply_attachment') < events.findIndex(item => item.type === 'done'));
  const sessionId = events[0].sessionId;
  const messages = f.lab.store.messages(sessionId);
  assert.deepEqual(messages.at(-1).attachments, [event.attachment]);
  assert(messages.at(-1).parts.every(part => typeof part === 'string'));
  assert(!messages.at(-1).text.includes(imageUrl));
  assert(!JSON.stringify(memoryRequestFor(messages, 'Asia/Shanghai').messages).includes(imageUrl));
  const storedCalls = f.lab.store.usage(sessionId).recordedCalls;
  const replay = await f.chat('看火星', 'image-replay');
  assert.deepEqual(replay.filter(item => item.type === 'reply_attachment'), [event]);
  assert.deepEqual(f.counts, { model: 2, search: 1 }, 'no image model step or replay request');
  assert.equal(f.lab.store.usage(sessionId).recordedCalls, storedCalls);
  assert.equal(f.lab.store.messages(sessionId).length, 2);
  const refreshed = await (await fetch(`${f.origin}/api/sessions/${sessionId}?childId=${f.scope.childId}&agentId=${f.scope.agentId}`)).json();
  assert.deepEqual(refreshed.messages.at(-1).attachments, [event.attachment]);
  await f.chat('继续');
  assert.equal(f.lab.store.messages(sessionId).at(-1).attachments, undefined);
  assert.deepEqual(f.counts, { model: 3, search: 1 }, 'cached search never auto-repeats a picture');
  const other = f.lab.store.createChild({ name: '独立测试用户', age: 20, interests: [] }, at);
  const foreign = await fetch(`${f.origin}/api/sessions/${sessionId}?childId=${other.id}&agentId=${f.scope.agentId}`);
  assert.equal(foreign.status, 404);
  f.lab.store.manuallyOpen(f.scope.childId, f.scope.agentId, at);
  const fresh = await f.chat('继续');
  assert(!fresh.some(item => item.type === 'reply_attachment'));
});

test('default false, explicit false, absent/invalid covers and untrusted provenance keep normal text replies', async t => {
  for (const options of [{ omitImageFlag: true }, { includeImage: false }, { result: mockResult({ noCover: true }) },
    { result: mockResult({ cover: 'https://localhost/private.jpg' }) }, { result: mockResult({ trusted: false }) }, { failSearch: true }]) {
    await t.test(JSON.stringify(options), async st => {
      const f = await imageLab(st, options);
      const events = await f.chat();
      assert(events.some(item => item.type === 'done'));
      assert(!events.some(item => item.type === 'reply_attachment'));
      assert.equal(f.lab.store.messages(events[0].sessionId).at(-1).attachments, undefined);
      assert.deepEqual(f.counts, { model: 2, search: 1 });
    });
  }
});

test('nonboolean image requests are rejected before any search dispatch', async t => {
  for (const includeImage of [null, 'true', 1]) await t.test(String(includeImage), async st => {
    const f = await imageLab(st, { includeImage });
    const events = await f.chat();
    assert(events.some(event => event.type === 'done'));
    assert(!events.some(event => event.type === 'reply_attachment'));
    assert.deepEqual(f.counts, { model: 2, search: 0 });
  });
});

test('failed, truncated and aborted answers never persist or emit a pending image', async t => {
  for (const mode of ['throw', 'length', 'abort']) await t.test(mode, async st => {
    const controller = new AbortController();
    const f = await imageLab(st, { final() {
      if (mode === 'throw') throw new Error('mock final failure');
      if (mode === 'abort') controller.abort();
      return { ...responseText('未完成的结果。'), receipt: { finish_reason: mode === 'length' ? 'length' : 'stop' } };
    } });
    const run = f.lab.runtime.beginChat({ ...f.scope, text: '看火星', requestId: crypto.randomUUID() });
    const events = [];
    await f.lab.runtime.chat(run, event => events.push(event), controller.signal);
    assert(!events.some(item => item.type === 'reply_attachment'));
    assert(!f.lab.store.messages(run.sessionId).some(message => message.attachments?.length));
    assert.equal(f.lab.store.sql('SELECT status FROM runs WHERE id=?').get(run.runId).status, 'failed');
  });
});

test('attachments survive restart while additive migration preserves legacy text and parts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-reference-images-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'isolated.sqlite');
  const first = await imageLab(t, { dbPath });
  const events = await first.chat('看火星', 'restart-reference');
  const attachment = events.find(event => event.type === 'reply_attachment').attachment;
  const sessionId = events[0].sessionId;
  await first.close();
  const restarted = await imageLab(t, { dbPath });
  assert.deepEqual(restarted.lab.store.messages(sessionId).at(-1).attachments, [attachment]);
  assert.deepEqual((await restarted.chat('看火星', 'restart-reference')).filter(event => event.type === 'reply_attachment'),
    [{ type: 'reply_attachment', attachment }]);
  assert.deepEqual(restarted.counts, { model: 0, search: 0 });
  await restarted.close();
  const legacyPath = join(directory, 'legacy.sqlite');
  let legacy = new ChatStore(legacyPath);
  legacy.activateVersion('legacy-test', at);
  const child = legacy.children()[0];
  const run = legacy.beginChat({ childId: child.id, agentId: 'legacy-agent', text: '在吗', requestId: 'legacy' }, at, 900000);
  legacy.finishChat(run, { reply: '在。\n\n继续聊。', parts: ['在。', '继续聊。'] }, at);
  legacy.db.exec('ALTER TABLE messages DROP COLUMN attachments');
  legacy.close();
  legacy = new ChatStore(legacyPath);
  assert.equal(legacy.messages(run.sessionId).at(-1).text, '在。\n\n继续聊。');
  assert.deepEqual(legacy.messages(run.sessionId).at(-1).parts, ['在。', '继续聊。']);
  assert.equal(legacy.messages(run.sessionId).at(-1).attachments, undefined);
  legacy.close();
});
