import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';
import { createCharacterMedia, plannedVideoDuration } from '../lib/character-media.mjs';

const role = { id: 'test-role', name: '角色', definition: '自然聊天。', metadata: { card: { portrait: '/assets/test.png' } } };
const attachment = { id: 'a'.repeat(48), kind: 'video' };
const motion = '她拿起刚泡好的咖啡，抿一口。';
const scene = '她坐在厨房窗边，手放在咖啡杯旁。';
const duration = 4;
const dialogue = '你看，我刚烤好了蛋糕。';
const ambience = '轻微风扇声，蛋糕盘碰到桌面。';

test('video dialogue duration counts spoken characters and rounds up', () => {
  assert.equal(plannedVideoDuration(3, '字'.repeat(14) + '，。 '), 3);
  assert.equal(plannedVideoDuration(3, '字'.repeat(15)), 4);
  assert.equal(plannedVideoDuration(3, '字'.repeat(23)), 5);
  assert.equal(plannedVideoDuration(3, '字'.repeat(24)), 6);
});

test('character video is delivered and replayed without another media generation', async () => {
  const requested = [];
  let rounds = 0;
  const provider = {
    async chat({ tools, messages }) {
      rounds++;
      assert(tools.some(tool => tool.function.name === 'send_character_video'));
      if (rounds === 1) return { content: '', toolCalls: [
        { id: 'video', type: 'function', function: { name: 'send_character_video', arguments: JSON.stringify({ framing: 'selfie', scene, motion, duration, dialogue, ambience }) } },
        { id: 'photo', type: 'function', function: { name: 'send_character_photo', arguments: JSON.stringify({ framing: 'subject', scene }) } },
      ] };
      const results = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      assert.deepEqual(results[0], { ok: true, delivered: 'video' });
      assert.equal(results[1].ok, false);
      return { content: '{"messages":["刚泡好咖啡。"]}', toolCalls: [] };
    },
  };
  const workspace = createBrowserWorkspace({ provider, defaultAgents: [role], defaultChildren: [{ name: '访客', age: 22 }],
    model: { name: 'mock', configured: true }, memoryModel: { configured: false },
    characterMedia: { available: () => true, async generate(kind, args) {
      requested.push({ kind, agent: args.agent.id, framing: args.framing, scene: args.scene, motion: args.motion, duration: args.duration, dialogue: args.dialogue, ambience: args.ambience });
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
  assert.deepEqual(requested, [{ kind: 'video', agent: role.id, framing: 'selfie', scene, motion, duration, dialogue, ambience }]);
  assert.deepEqual(events.find(event => event.type === 'character_media')?.attachment, attachment);
  assert.deepEqual(JSON.parse(result.snapshot.tables.messages.find(row => row.role === 'assistant').attachment), attachment);
  const usage = result.snapshot.tables.usage_records.map(row => JSON.parse(row.entry)).find(row => row.kind === 'character_media');
  assert.equal(usage.providerId, 'media-paid');
  assert.equal(usage.mediaBilling.actualMicroUsd, 121000);
  const replay = [];
  await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: result.snapshot, scope, body },
    { emit: event => replay.push(event) });
  assert.deepEqual(replay.find(event => event.type === 'character_media')?.attachment, attachment);
  assert.equal(requested.length, 1);
});

test('failed media sends leave a conversational reply and keep the underlying error in context', async t => {
  for (const kind of ['photo', 'video']) {
    for (const error of ['Provider timed out', 'Media service HTTP 503']) {
      await t.test(`${kind}: ${error}`, async () => {
        const name = `send_character_${kind}`;
        const argumentsJSON = JSON.stringify({ framing: 'subject', scene, ...(kind === 'video' ? { motion, duration } : {}) });
        let attempts = 0;
        const provider = {
          async chat() {
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
        const expected = '网络有点不好，等一下我再发给你吧。';
        assert.equal(attempts, 1);
        assert(events.some(event => event.type === 'tool_status' && event.status === 'complete'));
        assert(events.some(event => event.type === 'done'));
        assert(!events.some(event => event.type === 'error' || event.type === 'character_media'));
        assert.equal(events.find(event => event.type === 'reply_part' && event.kind === 'answer')?.text, expected);
        const sessionId = events.find(event => event.type === 'start').sessionId;
        const session = await workspace.execute({ method: 'GET', path: `/api/sessions/${sessionId}?${new URLSearchParams(scope)}`, snapshot: result.snapshot, scope });
        const reply = session.value.messages.findLast(message => message.role === 'assistant');
        assert(reply.text.endsWith(expected));
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
  const clipDuration = fixedVoice ? 5 : 4;
  const speaker = 'S_CustomVoice';
  const selfie = framing === 'selfie';
  t.mock.method(globalThis, 'fetch', async (target, options) => {
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
        return Response.json({ upload_url: 'https://upload.r2.pika.art/signed-' + path, url: 'https://cdn.pika.art/' + path,
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
        assert(url.pathname.endsWith(selfie ? '/reference-to-video' : '/text-to-video'));
        assert.equal(request.duration, clipDuration);
        assert.equal(request.resolution, '480p');
        assert.deepEqual(request.references, selfie ? [{ type: 'image', url: 'https://cdn.pika.art/portrait' },
          ...(fixedVoice ? [{ type: 'audio', url: 'https://cdn.pika.art/voice' }] : [])] : undefined);
        assert.equal(request.prompt.includes(dialogue), selfie || !fixedVoice);
        assert(request.prompt.includes(ambience));
        assert.match(request.prompt, selfie ? /irregular wrist sway/ : /operator stays off-camera/);
        return Response.json({ id: 'media-video' });
      }
      case '/v1/media/jobs/media-video':
        return Response.json({ status: 'completed', billing: { state: 'settled', charge_micro_usd: 127001 },
          output: { video: { url: 'https://cdn.pika.art/result.mp4' } } });
      case '/result.mp4': return new Response(null, { status: 503 });
      default: throw new Error('Unexpected test path');
    }
  });
  const media = createCharacterMedia({ tokenFile, directory });
  const agent = { name: '测试角色', metadata: { card: { portrait: '/assets/lin-wanqing-avatar.png' },
    ...(fixedVoice ? { videoVoiceId: speaker } : {}) } };
  const result = await media.generate('video', { agent, framing, scene, motion, duration, dialogue, ambience, runId: 'upload-test',
    signal: new AbortController().signal, onUsage: entry => receipts.push(entry) });
  assert.equal(calls.at(-1), '/result.mp4');
  assert(!calls.some(path => path.includes('gpu-qwen')));
  assert.deepEqual(result, { ok: false, error: 'Media service HTTP 503' });
  assert.equal(receipts[0].mediaBilling.estimatedMicroUsd, clipDuration * (selfie ? 30000 : 10000));
  assert.equal(receipts.at(-1).mediaBilling.jobId, 'media-video');
  assert.equal(receipts.at(-1).mediaBilling.actualMicroUsd, 127001);
  assert.equal(receipts.at(-1).status, 'failed');
});
}

for (const framing of ['subject', 'selfie']) {
  test(`a ${framing} photo uses the production Qwen contract and delivers the ready PNG`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'chatlab-production-photo-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const tokenFile = join(directory, 'token');
    await writeFile(tokenFile, 'test-token');
    const portrait = '/assets/lin-wanqing-avatar.png';
    const image = await readFile(new URL('../public' + portrait, import.meta.url));
    const selfie = framing === 'selfie';
    const assetId = '11111111-2222-4333-8444-555555555555';
    let uploads = 0;
    let outputReads = 0;
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
        assert.match(prompt, selfie ? /Vertical 9:16.+<image1>/ : /Vertical 3:4.+operator stays off-camera/);
        assert.deepEqual({ ...request, parameters: format }, {
          model_id: 'qwen-image-2.1', operation: 'image.generate', contract_version: 'wanwen-viggle9-1',
          client_job_id: request.client_job_id,
          parameters: { mode: selfie ? 'i2i' : 't2i', width: selfie ? 576 : 768, height: 1024 },
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
      framing, scene: '窗边的小蛋糕', runId: 'photo-test', signal: new AbortController().signal });
    assert.equal(result.ok, true);
    assert.equal(uploads, Number(selfie));
    assert.equal(outputReads, selfie ? 2 : 1);
    const saved = await media.asset(result.attachment.id, 'photo');
    assert.deepEqual(await readFile(saved.file), image);
  });
}
