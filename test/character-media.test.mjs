import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';
import { createCharacterMedia } from '../lib/character-media.mjs';
import { readSharePhotoPlan, sharePhotoScene } from '../lib/share-photo.mjs';
import { compileShareVideo, normalizeShareVideoArguments, readShareVideoPlan, resolveVideoDuration } from '../lib/share-video.mjs';

const role = { id: 'test-role', name: '角色', definition: '自然聊天。', metadata: { card: { portrait: '/assets/test.png' } } };
const attachment = { id: 'a'.repeat(48), kind: 'video' };
const motion = 'gently swirling coffee in a ceramic cup';
const scene = 'bright kitchen window, quiet china clinking on a wooden counter';
const duration = 3;
const dialogue = '你看，我刚烤好了蛋糕。';
const videoArgs = (template_id = 'VID_POV_INTERACT', spoken_line = null, references = []) => ({
  should_send_video: true, template_id, spoken_line, references, environment_and_sound: scene,
  primary_subject: { asset_id: template_id === 'VID_SELFIE_TALK' ? 'character' : null, action_or_state: motion },
});
const videoPlan = (template, line, references) => {
  const args = videoArgs(template, line, references);
  const plan = readShareVideoPlan(args, new Set(args.references.map(({ id }) => id)));
  assert(plan);
  return plan;
};
const photoArgs = (template_id, action_or_state, references) => ({
  should_send_image: true, template_id,
  primary_subject: { asset_id: template_id.startsWith('SHOT_3RD_') || template_id.startsWith('SHOT_SELFIE_') ? 'character' : null, action_or_state },
  environment_context: 'a quiet place with soft ambient light', ...(references ? { references } : {}),
});

function mockPikaRelay(t, respond) {
  const isPika = target => {
    const { hostname } = new URL(target);
    return hostname.endsWith('.pika.art') || hostname.endsWith('.r2.cloudflarestorage.com');
  };
  t.mock.method(globalThis, 'fetch', (target, options) => {
    assert(!isPika(target), 'Pika must bypass the normal fetch path');
    return respond(target, options);
  });
  return { available: () => true, pikaFetch(target, options) {
    assert(isPika(target));
    return respond(target, options);
  } };
}

test('direct Qwen and Pika credentials work without Service Clan and stay on their API origins', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chatlab-direct-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const qwenTokenFile = join(directory, 'qwen-token'), pikaKeyFile = join(directory, 'pika-key');
  await writeFile(qwenTokenFile, 'fake-image-token\n', { mode: 0o600 });
  await writeFile(pikaKeyFile, 'fake-video-key\n', { mode: 0o600 });
  const png = await readFile(new URL('../public/assets/lin-wanqing-avatar.png', import.meta.url));
  const calls = [];
  let settled = false;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const { origin, pathname } = new URL(target);
    const headers = new Headers(options.headers);
    calls.push(pathname);
    assert.equal(options.redirect, 'error');
    assert.equal(headers.get('Authorization'), origin === 'https://8.137.116.27:5889' ? 'Bearer fake-image-token' : null);
    assert.equal(headers.get('X-API-Key'), origin === 'https://api.dev.pika.art' ? 'fake-video-key' : null);
    assert.equal(headers.has('X-Service-Clan-Token'), false);
    switch (origin + pathname) {
      case 'https://8.137.116.27:5889/api/v2/jobs': return Response.json({ job_id: 'photo' });
      case 'https://8.137.116.27:5889/api/v2/jobs/photo': return Response.json({ status: 'succeeded' });
      case 'https://8.137.116.27:5889/api/v2/jobs/photo/outputs': return Response.json({ items: [
        { output_type: 'image', output_id: 'image', delivery_state: 'ready', media_type: 'image/png' },
      ] });
      case 'https://8.137.116.27:5889/api/v2/jobs/photo/outputs/image/content': return new Response(png);
      case 'https://api.dev.pika.art/v1/media/pika/pika-h3-flex/text-to-video': return Response.json({ id: 'clip' });
      case 'https://api.dev.pika.art/v1/media/jobs/clip': return Response.json({ status: 'completed',
        billing: settled ? { state: 'settled', charge_micro_usd: 17_000 } : null,
        output: { video: { url: 'https://cdn.pika.art/clip.mp4' } } });
      case 'https://cdn.pika.art/clip.mp4': return new Response(null, { status: 503 });
      default: throw new Error('Unexpected direct media URL');
    }
  });
  const images = createCharacterMedia({ qwenTokenFile, directory });
  const videos = createCharacterMedia({ pikaKeyFile, directory });
  await Promise.all([images.refresh(), videos.refresh()]);
  assert.equal(images.available('photo', role), true);
  assert.equal(images.available('video', role), false);
  assert.equal(videos.available('photo', role), false);
  assert.equal(videos.available('video', role), true);
  const signal = new AbortController().signal;
  const photoPlan = readSharePhotoPlan(photoArgs('SHOT_POV_SUBJECT', 'a cake'), new Set());
  const photo = await images.generate('photo', { agent: role, photoPlan, runId: 'direct-photo', signal });
  assert.equal(photo.attachment?.kind, 'photo', photo.error);
  assert.deepEqual(await readFile((await images.asset(photo.attachment.id, 'photo')).file), png);

  const receipts = [];
  const video = await videos.generate('video', { agent: role, videoPlan: videoPlan('VID_AMBIENT_LOOP'),
    runId: 'direct-video', signal, onUsage: entry => receipts.push(entry) });
  assert.deepEqual(video, { ok: false, error: 'Pika 视频下载失败（HTTP 503）' });
  assert.equal(calls.at(-1), '/clip.mp4');
  const { receiptProof, state } = receipts.at(-1).mediaBilling;
  assert.equal(state, 'pending');
  assert.match(receiptProof, /^[a-f0-9]{64}$/);
  const before = calls.length;
  await videos.readVideoBilling('another-job', receiptProof, signal);
  assert.equal(calls.length, before, 'a proof only authorizes the job that produced it');
  settled = true;
  assert.deepEqual(await videos.readVideoBilling('clip', receiptProof, signal), { state: 'settled', actualMicroUsd: 17_000 });
  assert.deepEqual(calls.slice(before), ['/v1/media/jobs/clip']);
  assert.equal(calls.some(path => path.startsWith('/api/services/')), false);
});

test('an unavailable Pika relay fails before making any network request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected normal fetch'));
  const pikaFetch = t.mock.fn(() => assert.fail('Unexpected tunnel request'));
  const media = createCharacterMedia({ pikaRelay: { available: () => false, pikaFetch } });
  const result = await media.generate('video', { agent: role, framing: 'subject', scene, motion, duration,
    signal: new AbortController().signal });
  assert.deepEqual(result, { ok: false, error: '成都 → 新加坡视频隧道不可用' });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(pikaFetch.mock.callCount(), 0);
});

test('Pika failures identify the stage using confirmed signals and never resubmit the job', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chatlab-video-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pikaKeyFile = join(directory, 'pika-key');
  await writeFile(pikaKeyFile, 'test-key\n', { mode: 0o600 });
  const media = createCharacterMedia({ directory, pikaKeyFile, ffmpeg: join(directory, 'missing-ffmpeg') });
  const job = () => Response.json({ id: 'clip' });
  const completed = () => Response.json({ status: 'completed', output: { video: { url: 'https://cdn.pika.art/clip.mp4' } } });
  const networkError = () => new TypeError('private URL with signed parameters', { cause: { code: 'ECONNRESET' } });
  const reset = () => { throw networkError(); };
  const scenarios = [
    ['提交断线', [reset], 'Pika 视频任务提交遇到网络错误（ECONNRESET）'],
    ['查询断线', [job, reset], 'Pika 视频状态查询遇到网络错误（ECONNRESET）'],
    ['查询 HTTP 出错', [job, () => new Response(null, { status: 429 })], 'Pika 视频状态查询失败（HTTP 429）'],
    ['查询超时', [job, () => { throw new DOMException('private detail', 'TimeoutError'); }], 'Pika 视频状态查询超时'],
    ['任务失败', [job, () => Response.json({ status: 'failed', error: 'private detail' })], 'Pika 视频任务已失败'],
    ['任务取消', [job, () => Response.json({ status: 'cancelled' })], 'Pika 视频任务已取消'],
    ['下载流中断', [job, completed, () => new Response(new ReadableStream({
      start(controller) { controller.error(networkError()); },
    }))], 'Pika 视频下载遇到网络错误（ECONNRESET）'],
    ['未知错误', [() => { throw new TypeError('private detail'); }], 'Pika 视频任务提交失败（原因未确认）'],
    ['本地处理失败', [job, completed, () => new Response(Buffer.from('0000ftyp'))], '本地视频处理失败'],
  ];
  for (const [title, responses, expected] of scenarios) await t.test(title, async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push(options.method ?? 'GET');
      return responses[requests.length - 1]();
    });
    const receipts = [];
    const result = await media.generate('video', { agent: role, videoPlan: videoPlan('VID_AMBIENT_LOOP'),
      runId: title, signal: new AbortController().signal, onUsage: entry => receipts.push(entry) });
    assert.deepEqual(result, { ok: false, error: expected });
    assert.equal(requests.length, responses.length);
    assert.equal(requests.filter(verb => verb === 'POST').length, 1);
    assert.equal(receipts.at(-1).mediaBilling.jobId, responses.length > 1 ? 'clip' : null);
  });
});

test('Share Video uses the template duration or rounds up with the spoken-line buffer', () => {
  assert.equal(resolveVideoDuration(5, ''), 5);
  assert.equal(resolveVideoDuration(5, '字'.repeat(11) + '，。 '), 3);
  assert.equal(resolveVideoDuration(3, '字'.repeat(12)), 4);
  assert.equal(resolveVideoDuration(3, '字'.repeat(17)), 5);
  assert.equal(resolveVideoDuration(3, '字'.repeat(22)), 6);
  assert.equal(resolveVideoDuration(3, '一段测试用台词', 4.8), 6);
});

test('Share Video validates one beat and keeps the landscape voice disabled', () => {
  const args = videoArgs('VID_AMBIENT_LOOP', dialogue);
  const plan = readShareVideoPlan(args, new Set());
  assert.equal(plan.spokenLine, '');
  assert.equal(plan.duration, 5);
  const prompt = compileShareVideo(plan, {});
  assert(prompt.startsWith(plan.template.locked_prompt.camera_prefix));
  assert(prompt.endsWith(plan.template.locked_prompt.realism_suffix));
  assert.match(prompt, /No speech, ambient foley only/);
  assert(!prompt.includes(dialogue));
  args.primary_subject.action_or_state = 'turning then walking';
  assert.equal(readShareVideoPlan(args, new Set()), null);
});

test('POV video keeps its scene when a model wraps the sound and names the limb as an asset', () => {
  const args = normalizeShareVideoArguments({ should_send_video: true, template_id: 'VID_POV_INTERACT',
    primary_subject: { asset_id: null, action_or_state: 'a wooden spoon slowly stirring milk pudding in a glass bowl' },
    secondary_subject: { asset_id: 'character-variant', action_or_state: 'a green-sleeved hand resting at the bowl edge', framing_mode: 'partial_limb_only' },
    environment_and_sound: { asset_id: null, environment_and_sound: 'glass bowl on wooden table, soft wet spoon swirls' },
  });
  const plan = readShareVideoPlan(args, new Set());
  assert.equal(plan.primary.text, 'wooden spoon slowly stirring milk pudding in glass bowl');
  assert.equal(plan.secondary.id, 'character');
  assert.equal(plan.environment, 'glass bowl on wooden table, soft wet spoon swirls');
});

test('Share Video normalizes a wrapped scene and derives prop framing from the shot', () => {
  const args = {
    ...videoArgs('VID_SELFIE_TALK', '这次再发不出，就真怪它了'),
    primary_subject: { asset_id: 'character', action_or_state: 'tilting head with a slight smirk' },
    secondary_subject: { asset_id: null, action_or_state: 'holding a small whisk', framing_mode: 'partial_limb_only' },
    environment_and_sound: { string: 'warm bakery lights humming, faint clink of bowls' },
  };
  const invalidFields = [];
  assert.equal(readShareVideoPlan(args, new Set(), invalidFields), null);
  assert.deepEqual(invalidFields, ['secondary_subject', 'environment_and_sound']);

  const normalized = normalizeShareVideoArguments(args);
  assert.equal(normalized.secondary_subject.framing_mode, 'full_object');
  assert.equal(normalized.environment_and_sound, args.environment_and_sound.string);
  assert.equal(normalized.spoken_line, null);
  const plan = readShareVideoPlan(normalized, new Set());
  assert.equal(plan.duration, 4);
  const prompt = compileShareVideo(plan, {});
  assert.match(prompt, /holding a small whisk/);
  assert.doesNotMatch(prompt, /怪它了/);

  const invalid = normalizeShareVideoArguments({ ...args, secondary_subject: { ...args.secondary_subject, asset_id: 'character' } });
  assert.equal(readShareVideoPlan(invalid, new Set()), null);
});

test('workspace tools reflect current media availability without changing a past turn', async () => {
  let photosEnabled = false;
  const workspace = createBrowserWorkspace({
    defaultAgents: [role], defaultChildren: [{ name: '访客', age: 22 }],
    model: { name: 'mock', configured: true }, memoryModel: { configured: false }, search: { configured: true },
    characterMedia: { available: kind => kind === 'video' || photosEnabled },
    provider: { async chat({ tools }) {
      assert.equal(tools.length, 5);
      return { content: '{"messages":["在。"]}' };
    } },
  });
  const state = { method: 'GET', path: '/api/state' };
  const initial = await workspace.execute(state);
  const scope = { childId: initial.value.children[0].id, agentId: role.id };
  const oldNames = initial.value.availableTools.byAgent[role.id];
  assert.equal(oldNames.length, 5);

  const chat = await workspace.execute({ method: 'POST', path: '/api/chat', scope, snapshot: initial.snapshot,
    body: { ...scope, text: '在吗', requestId: 'before-photo-enabled' } });
  photosEnabled = true;
  const current = await workspace.execute({ ...state, scope, snapshot: chat.snapshot });
  const names = current.value.availableTools.byAgent[role.id];
  assert.equal(names.length, 6);
  assert(names.includes('share_photo'));
  assert.equal(current.value.availableTools.definitions.share_photo.function.name, 'share_photo');
  const pastTurn = Object.values(current.views).find(view => view.context?.tools);
  assert.deepEqual(pastTurn.context.tools.map(tool => tool.function.name), oldNames);
});

test('character video is delivered and replayed without another media generation', async () => {
  const requested = [];
  let rounds = 0;
  const provider = {
    async chat({ tools, messages }) {
      rounds++;
      assert(tools.some(tool => tool.function.name === 'share_video'));
      if (rounds === 1) return { content: '', toolCalls: [
        { id: 'video', type: 'function', function: { name: 'share_video', arguments: JSON.stringify(videoArgs('VID_SELFIE_TALK', dialogue)) } },
        { id: 'photo', type: 'function', function: { name: 'share_photo', arguments: JSON.stringify(photoArgs('SHOT_POV_SUBJECT', 'a cup of coffee')) } },
      ] };
      const results = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      assert.deepEqual(results[0], { media: 'video', sent: true, description: { scene, motion } });
      assert.deepEqual(results[1], { media: 'photo', sent: false, description: null });
      return { content: '{"messages":["刚泡好咖啡。"]}', toolCalls: [] };
    },
  };
  const workspace = createBrowserWorkspace({ provider, defaultAgents: [role], defaultChildren: [{ name: '访客', age: 22 }],
    model: { name: 'mock', configured: true }, memoryModel: { configured: false },
    characterMedia: { available: () => true, async generate(kind, args) {
      requested.push({ kind, agent: args.agent.id, template: args.videoPlan.template.template_id, scene: args.scene, motion: args.motion, duration: args.videoPlan.duration, dialogue: args.videoPlan.spokenLine });
      args.onUsage({ phase: 'complete', model: 'pika-h3-flex', receipt: { provider_id: 'media-paid' },
        mediaBilling: { duration, estimatedMicroUsd: 120000, actualMicroUsd: 121000, state: 'settled' } });
      return { ok: true, attachment };
    } } });
  const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
  const scope = { childId: boot.value.children[0].id, agentId: role.id };
  const body = { ...scope, text: '发段你正在干嘛的视频', requestId: 'role-video-once' };
  const events = [];
  const result = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: boot.snapshot, scope, body },
    { emit: event => events.push(event) });
  assert.deepEqual(requested, [{ kind: 'video', agent: role.id, template: 'VID_SELFIE_TALK', scene, motion, duration, dialogue }]);
  assert.deepEqual(events.find(event => event.type === 'character_media')?.attachment, attachment);
  assert(events.findIndex(event => event.type === 'character_media') < events.findIndex(event => event.type === 'reply_part'));
  assert.deepEqual(events.filter(event => event.type === 'reply_part'), [
    { type: 'reply_part', index: 0, text: '刚泡好咖啡。', kind: 'answer' },
  ]);
  assert.deepEqual(JSON.parse(result.snapshot.tables.messages.find(row => row.role === 'assistant').attachment), attachment);
  const usage = result.snapshot.tables.usage_records.map(row => JSON.parse(row.entry)).find(row => row.kind === 'character_media');
  assert.equal(usage.providerId, 'media-paid');
  assert.equal(usage.mediaBilling.actualMicroUsd, 121000);
  const replay = [];
  await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: result.snapshot, scope, body },
    { emit: event => replay.push(event) });
  assert.deepEqual(replay.find(event => event.type === 'character_media')?.attachment, attachment);
  assert.deepEqual(replay.filter(event => event.type === 'reply_part'), events.filter(event => event.type === 'reply_part'));
  assert.equal(requested.length, 1);
});

test('failed media sends leave a conversational reply and keep the underlying error in context', async t => {
  for (const kind of ['photo', 'video']) {
    for (const error of ['Provider timed out', 'Media service HTTP 503']) {
      await t.test(`${kind}: ${error}`, async () => {
        const name = kind === 'photo' ? 'share_photo' : 'share_video';
        const argumentsJSON = JSON.stringify(kind === 'photo' ? photoArgs('SHOT_POV_SUBJECT', 'a blue-rimmed cup')
          : videoArgs());
        let attempts = 0;
        const expected = kind === 'photo' ? '我手里这只杯子是蓝边的。' : '我刚冲好咖啡。';
        const description = kind === 'photo' ? { scene: 'a blue-rimmed cup, a quiet place with soft ambient light' } : { scene, motion };
        let continuations = 0;
        const provider = {
          async chat({ messages, tools }) {
            if (messages.at(-1).role === 'tool') {
              assert.deepEqual(tools, []);
              assert(messages.some(message => message.role === 'user' && message.content === '拍一下你现在在做什么'));
              assert.deepEqual(JSON.parse(messages.at(-1).content), { media: kind, sent: false, description });
              assert(messages[0].content.includes('直接承接对方正在聊的内容'));
              assert(!JSON.stringify(messages).includes(error));
              continuations++;
              return { content: JSON.stringify({ messages: [expected] }) };
            }
            return { content: '', toolCalls: [{ id: 'send-media', type: 'function', function: { name, arguments: argumentsJSON } }] };
          },
        };
        const workspace = createBrowserWorkspace({
          provider, defaultAgents: [role], defaultChildren: [{ name: '访客', age: 22 }],
          model: { name: 'mock', configured: true }, memoryModel: { configured: false },
          characterMedia: {
            available: () => true,
            async generate(actualKind) {
              assert.equal(actualKind, kind);
              attempts++;
              return { ok: false, error };
            },
          },
        });
        const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
        const scope = { childId: boot.value.children[0].id, agentId: role.id };
        const body = { ...scope, text: '拍一下你现在在做什么', requestId: 'unavailable-media-once' };
        const events = [];
        const result = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: boot.snapshot, scope, body },
          { emit: event => events.push(event) });
        assert.equal(attempts, 1);
        assert.equal(continuations, 1);
        assert(events.some(event => event.type === 'tool_status' && event.status === 'complete'));
        assert(events.some(event => event.type === 'done'));
        assert(!events.some(event => event.type === 'error' || event.type === 'character_media'));
        assert.deepEqual(events.filter(event => event.type === 'reply_part'), [
          { type: 'reply_part', index: 0, text: expected, kind: 'answer' },
        ]);
        const sessionId = events.find(event => event.type === 'start').sessionId;
        const session = await workspace.execute({ method: 'GET', path: `/api/sessions/${sessionId}?${new URLSearchParams(scope)}`, snapshot: result.snapshot, scope });
        const reply = session.value.messages.findLast(message => message.role === 'assistant');
        assert.equal(reply.text, expected);
        assert(!reply.text.includes(error));
        assert.deepEqual(session.value.context.toolCalls[0].result, { ok: false, error });
        assert.equal(session.value.context.toolCalls[0].usage.status, 'failed');
      });
    }
  }
});

for (const [framing, fixedVoice] of [['selfie', false], ['selfie', true], ['subject', false], ['subject', true]]) {
test(`Pika generates ${framing} framing with ${fixedVoice ? 'measured ICL audio' : 'native speech'}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chatlab-signed-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'test-token');
  const portrait = new URL('../public/assets/lin-wanqing-avatar.png', import.meta.url);
  const image = await readFile(portrait);
  const calls = [];
  const receipts = [];
  const requestedDuration = fixedVoice && framing === 'selfie' ? 6 : undefined;
  const clipDuration = requestedDuration ?? (fixedVoice ? 5 : 3);
  const speaker = 'S_CustomVoice';
  const selfie = framing === 'selfie';
  let submittedPrompt;
  const pikaRelay = mockPikaRelay(t, async (target, options) => {
    const url = new URL(target);
    calls.push(url.pathname);
    switch (url.pathname) {
      case '/api/services/volc-icl20-sse/connection':
        assert(fixedVoice);
        return Response.json({ base_url: 'https://openspeech.bytedance.com', headers: { 'X-Api-Resource-Id': 'seed-icl-2.0' } });
      case '/api/v3/tts/unidirectional/sse': {
        assert(fixedVoice);
        assert.equal(JSON.parse(options.body).req_params.speaker, speaker);
        assert.equal(JSON.parse(options.body).req_params.text, dialogue);
        const pcm = Buffer.alloc(201600, 12).toString('base64');
        return new Response(`data: ${JSON.stringify({ code: 0, data: pcm })}\n\ndata: {"code":20000000}\n\n`);
      }
      case '/api/services/pika-h3-flex/connection':
        return Response.json({ base_url: 'https://api.dev.pika.art', model: 'pika-h3-flex', headers: { 'X-API-Key': 'test-key' } });
      case '/v1/media/uploads': {
        assert(selfie);
        const upload = JSON.parse(options.body);
        const path = upload.content_type === 'audio/wav' ? 'voice' : 'portrait';
        return Response.json({ upload_url: 'https://test.r2.cloudflarestorage.com/signed-' + path, url: 'https://cdn.pika.art/' + path,
          headers: { 'Content-Type': upload.content_type, 'Content-Length': String(upload.size_bytes),
            'Cache-Control': 'public, max-age=3600' } });
      }
      case '/signed-portrait':
        assert.equal(options.method, 'PUT');
        assert.equal(options.headers.get('Content-Type'), 'image/png');
        assert.equal(options.headers.get('Content-Length'), String(image.length));
        assert.equal(options.headers.get('Cache-Control'), 'public, max-age=3600');
        assert.equal(options.headers.has('X-API-Key'), false);
        assert.deepEqual(options.body, image);
        return new Response(null, { status: 200 });
      case '/signed-voice':
        assert(fixedVoice);
        assert.equal(options.headers.get('Content-Type'), 'audio/wav');
        assert.equal(options.body.toString('ascii', 0, 4), 'RIFF');
        return new Response(null, { status: 200 });
      case '/v1/media/pika/pika-h3-flex/reference-to-video':
      case '/v1/media/pika/pika-h3-flex/text-to-video': {
        const request = JSON.parse(options.body);
        assert.equal(submittedPrompt, request.prompt);
        assert(url.pathname.endsWith(selfie ? '/reference-to-video' : '/text-to-video'));
        assert.equal(request.duration, clipDuration);
        assert.equal(request.resolution, '480p');
        assert.deepEqual(request.references, selfie ? [{ type: 'image', url: 'https://cdn.pika.art/portrait' },
          ...(fixedVoice ? [{ type: 'audio', url: 'https://cdn.pika.art/voice' }] : [])] : undefined);
        assert.equal(request.prompt.includes(dialogue), selfie || !fixedVoice);
        assert(request.prompt.includes(scene));
        assert.match(request.prompt, selfie ? /front-facing iPhone selfie/ : /First-person POV/);
        return Response.json({ id: 'media-video' });
      }
      case '/v1/media/jobs/media-video':
        return Response.json({ status: 'completed', billing: { state: 'settled', charge_micro_usd: 127001 },
          output: { video: { url: 'https://cdn.pika.art/result.mp4' } } });
      case '/result.mp4': return new Response(null, { status: 503 });
      default: throw new Error('Unexpected test path');
    }
  });
  const media = createCharacterMedia({ tokenFile, directory, pikaRelay });
  const agent = { name: '测试角色', metadata: { card: { portrait: '/assets/lin-wanqing-avatar.png' },
    ...(fixedVoice ? { videoVoiceId: speaker } : {}) } };
  const plan = readShareVideoPlan({ ...videoArgs(selfie ? 'VID_SELFIE_TALK' : 'VID_POV_INTERACT', dialogue),
    duration_seconds: requestedDuration }, new Set());
  const result = await media.generate('video', { agent, videoPlan: plan, runId: 'upload-test',
    signal: new AbortController().signal, onUsage: entry => receipts.push(entry), onPrompt: prompt => { submittedPrompt = prompt; } });
  assert.equal(calls.at(-1), '/result.mp4');
  assert(!calls.some(path => path.includes('gpu-qwen')));
  assert.deepEqual(result, { ok: false, error: 'Pika 视频下载失败（HTTP 503）' });
  assert.equal(receipts[0].mediaBilling.estimatedMicroUsd, clipDuration * (selfie ? 30_000 : 10_000));
  assert.equal(receipts.at(-1).mediaBilling.jobId, 'media-video');
  assert.equal(receipts.at(-1).mediaBilling.actualMicroUsd, 127001);
  assert.equal(receipts.at(-1).status, 'failed');
});
}

test('a video is delivered before billing and the workspace later saves the receipt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chatlab-pika-billing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'test-token');
  const clip = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=90x160:r=24',
    '-t', '0.5', '-c:v', 'libx264', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
  assert.equal(clip.status, 0, clip.stderr?.toString());

  let now = Date.parse('2026-11-23T01:00:00Z');
  let billing = null;
  const calls = [];
  const pikaRelay = mockPikaRelay(t, async target => {
    const { pathname } = new URL(target);
    calls.push(pathname);
    switch (pathname) {
      case '/api/services/pika-h3-flex/connection':
        return Response.json({ base_url: 'https://api.dev.pika.art', model: 'pika-h3-flex', headers: {} });
      case '/v1/media/pika/pika-h3-flex/text-to-video': return Response.json({ id: 'media-pending' });
      case '/v1/media/jobs/media-pending':
        return Response.json({ status: 'completed', billing, output: { video: { url: 'https://cdn.pika.art/result.mp4' } } });
      case '/result.mp4': return new Response(clip.stdout);
      default: throw new Error('Unexpected test path');
    }
  });
  const media = createCharacterMedia({ tokenFile, directory, pikaRelay });
  const provider = { async chat({ messages }) {
    if (messages.at(-1).role === 'tool') return { content: '{"messages":["刚泡好咖啡。"]}' };
    return { content: '', toolCalls: [{ id: 'send-video', type: 'function', function: {
      name: 'share_video', arguments: JSON.stringify(videoArgs()),
    } }] };
  } };
  const workspace = createBrowserWorkspace({ provider, clock: () => new Date(now),
    defaultAgents: [role], defaultChildren: [{ name: '访客', age: 22 }],
    model: { name: 'mock', configured: true }, memoryModel: { configured: false },
    characterMedia: { ...media, available: kind => kind === 'video' } });
  const state = { method: 'GET', path: '/api/state' };
  const boot = await workspace.execute(state);
  const scope = { childId: boot.value.children[0].id, agentId: role.id };
  const events = [];
  const delivered = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: boot.snapshot, scope,
    body: { ...scope, text: '拍一段冲咖啡的视频', requestId: 'async-video-receipt' } }, { emit: event => events.push(event) });
  assert(events.some(event => event.type === 'character_media' && event.attachment.kind === 'video'));
  assert(events.some(event => event.type === 'done'));
  assert.deepEqual(calls.slice(-2), ['/v1/media/jobs/media-pending', '/result.mp4']);
  assert.equal(calls.filter(path => path === '/v1/media/jobs/media-pending').length, 1);
  assert.equal(delivered.nextDeadline, now + 2000);

  const usageRecord = result => JSON.parse(result.snapshot.tables.usage_records.find(row => row.kind === 'character_media').entry);
  const initial = usageRecord(delivered).mediaBilling;
  assert.equal(initial.state, 'pending');
  assert.equal(initial.estimatedMicroUsd, 30_000);
  assert.equal(initial.actualMicroUsd, null);
  assert.deepEqual(await media.readVideoBilling('other-job', initial.receiptProof, new AbortController().signal),
    { state: 'unavailable', actualMicroUsd: null });
  assert.equal(calls.at(-1), '/result.mp4');

  const sessionId = events.find(event => event.type === 'start').sessionId;
  const refresh = snapshot => workspace.execute({ ...state, snapshot, scope: { ...scope, sessionId } });
  now += 2000;
  const pending = await refresh(delivered.snapshot);
  assert.equal(pending.nextDeadline, now + 5000);
  assert.equal(usageRecord(pending).mediaBilling.state, 'pending');
  assert.equal(usageRecord(pending).mediaBilling.receiptChecks, 1);

  billing = { state: 'settled', charge_micro_usd: 41_000 };
  const oldRecord = pending.snapshot.tables.usage_records.find(row => row.kind === 'character_media');
  oldRecord.tool_name = 'send_character_video';
  const oldUsage = JSON.parse(oldRecord.entry);
  oldUsage.name = 'send_character_video';
  oldRecord.entry = JSON.stringify(oldUsage);
  now += 5000;
  const settled = await refresh(pending.snapshot);
  const usage = usageRecord(settled);
  assert.equal(usage.mediaBilling.actualMicroUsd, 41_000);
  assert.equal(usage.mediaBilling.state, 'settled');
  assert.equal(usage.mediaBilling.receiptProof, undefined);
  assert.equal(settled.nextDeadline, Date.parse('2026-11-23T01:15:00Z'));
  const session = Object.values(settled.views).find(view => view.session?.id === sessionId);
  assert.equal(session.usage.calls.find(call => call.kind === 'character_media').mediaBilling.actualMicroUsd, 41_000);
  assert.equal(session.context.toolCalls[0].usage.mediaBilling.actualMicroUsd, 41_000);
  assert.equal(calls.filter(path => path === '/result.mp4').length, 1);
});

for (const template of ['SHOT_POV_SUBJECT', 'SHOT_3RD_FULL']) {
  test(`a ${template} photo uses the production Qwen contract and delivers the ready PNG`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'chatlab-production-photo-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const tokenFile = join(directory, 'token');
    await writeFile(tokenFile, 'test-token');
    const portrait = '/assets/lin-wanqing-avatar.png';
    const image = await readFile(new URL('../public' + portrait, import.meta.url));
    const photoPlan = readSharePhotoPlan(photoArgs(template, 'standing by the window with a small cake'), new Set());
    const selfie = photoPlan.includePortrait;
    const assetId = '11111111-2222-4333-8444-555555555555';
    let uploads = 0;
    let outputReads = 0;
    let submittedPrompt;
    t.mock.method(globalThis, 'fetch', async (target, options) => {
      const url = new URL(target);
      if (url.pathname === '/api/services/gpu-qwen-image-21-app-production/connection') {
        assert.equal(options.headers['X-Service-Clan-Token'], 'test-token');
        return Response.json({ base_url: 'https://8.137.116.27:5889', model: 'qwen-image-2.1',
          headers: { Authorization: 'Bearer production-test-key' } });
      }
      assert.equal(url.origin, 'https://8.137.116.27:5889');
      assert.equal(options.headers.Authorization, 'Bearer production-test-key');
      if (url.pathname === '/api/v2/assets/images') {
        assert(selfie);
        assert.equal(options.method, 'POST');
        const file = options.body.get('file');
        assert.equal(file.name, 'lin-wanqing-avatar.png');
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), image);
        uploads++;
        return Response.json({ asset_id: assetId }, { status: 201 });
      }
      if (url.pathname === '/api/v2/jobs') {
        assert.equal(options.method, 'POST');
        const request = JSON.parse(options.body);
        assert.equal(options.headers['X-Online-Capability'], 'image-generation');
        assert.equal(options.headers['Idempotency-Key'], request.client_job_id);
        assert.match(request.client_job_id, /^chatlab-[a-f0-9]{40}$/);
        const { prompt, ...format } = request.parameters;
        assert.equal(submittedPrompt, prompt);
        assert(prompt.startsWith(photoPlan.template.locked_prompt.camera_prefix + ' '));
        assert(prompt.endsWith(photoPlan.template.locked_prompt.realism_suffix));
        assert.match(prompt, selfie ? /full figure from head to shoes.+<image1>/ : /First-person POV snapshot/);
        assert.deepEqual({ ...request, parameters: format }, {
          model_id: 'qwen-image-2.1', operation: 'image.generate', contract_version: 'wanwen-viggle9-1',
          client_job_id: request.client_job_id,
          parameters: { mode: selfie ? 'i2i' : 't2i', width: selfie ? 576 : 1152, height: selfie ? 1024 : 864 },
          inputs: selfie ? [{ role: 'reference_image', asset_id: assetId }] : [],
        });
        return Response.json({ job_id: 'photo' }, { status: 202 });
      }
      if (url.pathname === '/api/v2/jobs/photo') return Response.json({ status: 'succeeded' });
      if (url.pathname === '/api/v2/jobs/photo/outputs') {
        outputReads++;
        return Response.json({ items: [
          { output_type: 'image', output_id: 'thumbnail', delivery_state: 'ready', media_type: 'image/jpeg' },
          { output_type: 'image', output_id: 'primary-png', delivery_state: selfie && outputReads === 1 ? 'pending' : 'ready',
            media_type: 'image/png' },
        ] });
      }
      if (url.pathname === '/api/v2/jobs/photo/outputs/primary-png/content') return new Response(image);
      throw new Error('Unexpected photo request');
    });
    const media = createCharacterMedia({ tokenFile, directory });
    const result = await media.generate('photo', { agent: { name: '角色', metadata: { card: { portrait } } },
      photoPlan, runId: 'photo-test', signal: new AbortController().signal,
      onPrompt: prompt => { submittedPrompt = prompt; } });
    assert.equal(result.ok, true);
    assert.equal(uploads, Number(selfie));
    assert.equal(outputReads, selfie ? 2 : 1);
    const saved = await media.asset(result.attachment.id, 'photo');
    assert.deepEqual(await readFile(saved.file), image);
  });
}

test('the same conversation can reuse room and object photos for a selfie and a video', async t => {
  if (spawnSync('ffmpeg', ['-version']).error?.code === 'ENOENT') return t.skip('FFmpeg combines photo references');
  const directory = await mkdtemp(join(tmpdir(), 'chatlab-reference-continuity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'test-token');
  const room = 'a walnut table by a window with a green lamp on the right';
  const cup = 'a chipped blue teacup to the left of the lamp';
  const roomPhoto = photoArgs('SHOT_WIDE_SCENE', room);
  const selfiePhoto = photoArgs('SHOT_SELFIE_CLOSE', cup, [{ id: 'photo-1', keep: room }]);
  const roomCandidate = { scene: sharePhotoScene(roomPhoto), framing: 'subject', templateId: 'SHOT_WIDE_SCENE' };
  const image = await readFile(new URL('../public/assets/benny.png', import.meta.url));
  const portrait = '/assets/lin-wanqing-avatar.png';
  const portraitImage = await readFile(new URL('../public' + portrait, import.meta.url));
  const photoRequests = [];
  const pikaUploads = [];
  const submitted = [];
  let boardUploads = 0;
  const qwen = 'https://8.137.116.27:5889';
  const pika = 'https://api.dev.pika.art';
  const pikaRelay = mockPikaRelay(t, async (target, options) => {
    const url = new URL(target);
    switch (url.pathname) {
      case '/api/services/gpu-qwen-image-21-app-production/connection':
        return Response.json({ base_url: qwen, model: 'qwen-image-2.1', headers: {} });
      case '/api/v2/assets/images': {
        const file = options.body.get('file');
        assert.equal(file.name, 'reference-board.png');
        const png = Buffer.from(await file.arrayBuffer());
        assert.equal(png.readUInt32BE(16), 640);
        assert.equal(png.readUInt32BE(20), 384);
        boardUploads++;
        return Response.json({ asset_id: 'board' });
      }
      case '/api/v2/jobs':
        photoRequests.push(JSON.parse(options.body));
        return Response.json({ job_id: 'photo-job' });
      case '/api/v2/jobs/photo-job': return Response.json({ status: 'succeeded' });
      case '/api/v2/jobs/photo-job/outputs':
        return Response.json({ items: [{ output_id: 'image', media_type: 'image/png', delivery_state: 'ready' }] });
      case '/api/v2/jobs/photo-job/outputs/image/content': return new Response(image);
      case '/api/services/pika-h3-flex/connection':
        return Response.json({ base_url: pika, model: 'pika-h3-flex', headers: {} });
      case '/v1/media/uploads': {
        const index = pikaUploads.length;
        pikaUploads.push(null);
        return Response.json({ upload_url: 'https://upload.pika.art/signed-' + index, url: 'https://cdn.pika.art/ref-' + index });
      }
      case '/signed-0':
      case '/signed-1':
      case '/signed-2':
        pikaUploads[Number(url.pathname.at(-1))] = options.body;
        return new Response(null);
      case '/v1/media/pika/pika-h3-flex/reference-to-video':
        submitted.push(JSON.parse(options.body));
        return Response.json({ id: 'video-job' });
      case '/v1/media/jobs/video-job':
        return Response.json({ status: 'failed' }); // The reference request has been captured.
      default: throw new Error('Unexpected media endpoint');
    }
  });
  const media = createCharacterMedia({ tokenFile, directory, pikaRelay });
  await media.refresh();
  const provider = { async chat({ messages, tools }) {
    if (messages.at(-1).role === 'tool') return { content: '{"messages":["给你看看。"]}' };
    const choices = JSON.parse(messages[1].content.split('\n').at(-1)).photoReferences;
    const request = messages.at(-1).content;
    let kind = 'photo';
    let args;
    let content = '';
    if (request === '给我一张房间的照片') {
      assert.equal(choices, undefined);
      args = roomPhoto;
      content = '{"messages":["窗边这块刚好有太阳。"]}';
    } else if (request === '同一个地方自拍一下，给我看看蓝色茶杯') {
      assert.match(messages[0].content, /同一场景、物品、布局或外观/);
      assert.deepEqual(choices, [{ id: 'photo-1', ...roomCandidate }]);
      args = selfiePhoto;
    } else if (request === '在这儿录一小段视频，还是那只杯子') {
      assert.deepEqual(choices, [{ id: 'photo-1', scene: sharePhotoScene(selfiePhoto), framing: 'selfie', templateId: 'SHOT_SELFIE_CLOSE', keptDetails: [room] },
        { id: 'photo-2', ...roomCandidate }]);
      kind = 'video';
      args = videoArgs('VID_SELFIE_TALK', null, [{ id: 'photo-2', keep: room }, { id: 'photo-1', keep: cup }]);
    } else if (request === '现在在街角了，拍一张街景') {
      assert.equal(choices.length, 2);
      args = photoArgs('SHOT_WIDE_SCENE', 'a new street corner');
    } else {
      assert.equal(choices, undefined);
      args = photoArgs('SHOT_WIDE_SCENE', 'another scene', [{ id: 'photo-1', keep: room }]);
    }
    const name = kind === 'photo' ? 'share_photo' : 'share_video';
    assert(tools.find(({ function: tool }) => tool.name === name).function.parameters.properties.references);
    return { content, toolCalls: [{ id: 'capture', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
  } };
  const workspace = createBrowserWorkspace({ provider, characterMedia: media,
    defaultAgents: [{ ...role, metadata: { card: { portrait } } }], defaultChildren: [{ name: '访客', age: 22 }],
    model: { name: 'mock', configured: true }, memoryModel: { configured: false } });
  const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
  const scope = { childId: boot.value.children[0].id, agentId: role.id };
  let snapshot = boot.snapshot;
  let sessionId;
  async function turn(text, requestId) {
    const events = [];
    const response = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot, scope,
      body: { ...scope, ...(sessionId ? { sessionId } : {}), text, requestId } }, { emit: event => events.push(event) });
    sessionId = events.find(event => event.type === 'start')?.sessionId;
    assert(sessionId);
    snapshot = response.snapshot;
    return events;
  }

  const first = await turn('给我一张房间的照片', 'room-photo');
  assert.deepEqual(first.find(event => event.type === 'reply_part'), {
    type: 'reply_part', index: 0, text: '窗边这块刚好有太阳。', kind: 'acknowledgement',
  });
  const roomAttachment = first.find(event => event.type === 'character_media').attachment;
  const second = await turn('同一个地方自拍一下，给我看看蓝色茶杯', 'room-selfie');
  assert(second.some(event => event.type === 'character_media'));
  assert.deepEqual(second.filter(event => event.type === 'reply_part').map(event => event.kind), ['answer']);
  assert.equal(boardUploads, 1);
  assert.deepEqual(photoRequests.map(request => request.parameters.mode), ['t2i', 'i2i']);
  assert.deepEqual(photoRequests[1].inputs, [{ role: 'reference_image', asset_id: 'board' }]);
  assert(photoRequests[1].parameters.prompt.includes('panel 1 of <image1>'));
  assert(photoRequests[1].parameters.prompt.includes('preserve only these details from panel 2 of <image1>: ' + room));

  const third = await turn('在这儿录一小段视频，还是那只杯子', 'room-video');
  assert.deepEqual(pikaUploads, [portraitImage, image, image]);
  assert.deepEqual(submitted[0].references, [0, 1, 2].map(index => ({ type: 'image', url: 'https://cdn.pika.art/ref-' + index })));
  assert(submitted[0].prompt.includes('Reference image 2: preserve ' + room));
  assert(submitted[0].prompt.includes('Reference image 3: preserve ' + cup));
  assert.equal(third.findLast(event => event.type === 'tool_usage').call.mediaBilling.unitMicroUsd, 30_000);

  pikaUploads.length = 0;
  const subjectUsage = [];
  await media.generate('video', { agent: role, videoPlan: videoPlan('VID_POV_INTERACT', null, [{ id: 'photo-1', keep: room }]), sessionId,
    references: [{ assetId: roomAttachment.id, keep: room }], runId: 'room-only-video',
    signal: new AbortController().signal, onUsage: entry => subjectUsage.push(entry) });
  assert.deepEqual(pikaUploads, [image]);
  assert.deepEqual(submitted[1].references, [{ type: 'image', url: 'https://cdn.pika.art/ref-0' }]);
  assert(submitted[1].prompt.includes('Reference image 1: preserve ' + room));
  assert.equal(subjectUsage.at(-1).mediaBilling.unitMicroUsd, 30_000);

  await turn('现在在街角了，拍一张街景', 'new-scene');
  assert.equal(photoRequests[2].parameters.mode, 't2i');
  assert.deepEqual(await media.photoReferences([{ role: 'assistant', attachment: roomAttachment }], 'unrelated-session'), []);
  const another = await workspace.execute({ method: 'POST', path: '/api/sessions', snapshot, scope, body: scope });
  snapshot = another.snapshot;
  sessionId = another.value.session.id;
  const foreign = await turn('引用另一段会话的照片', 'foreign-reference');
  assert.equal(photoRequests.length, 3);
  assert(foreign.some(event => event.type === 'done'));
  assert(!foreign.some(event => event.type === 'character_media'));

  const old = { id: 'b'.repeat(48), kind: 'photo' };
  await writeFile(join(directory, old.id + '.photo'), image);
  assert.deepEqual(await media.photoReferences([{ role: 'user', text: '拍杯子' },
    { role: 'assistant', text: '给你看看。', attachment: old }], sessionId),
  [{ id: 'photo-1', assetId: old.id, reply: '给你看看。', request: '拍杯子' }]);
});
