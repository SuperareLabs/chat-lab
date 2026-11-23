import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';
import { createCharacterMedia } from '../lib/character-media.mjs';

const role = { id: 'test-role', name: '角色', definition: '自然聊天。', metadata: { card: { portrait: '/assets/test.png' } } };
const attachment = { id: 'a'.repeat(48), kind: 'video' };
const motion = '她拿起刚泡好的咖啡，抿一口。';
const scene = '她坐在厨房窗边，手放在咖啡杯旁。';
const duration = 4;

test('character video is delivered and replayed without another media generation', async () => {
  const requested = [];
  let rounds = 0;
  const provider = {
    async chat({ tools, messages }) {
      rounds++;
      assert(tools.some(tool => tool.function.name === 'send_character_video'));
      if (rounds === 1) return { content: '', toolCalls: [
        { id: 'video', type: 'function', function: { name: 'send_character_video', arguments: JSON.stringify({ scene, motion, duration }) } },
        { id: 'photo', type: 'function', function: { name: 'send_character_photo', arguments: JSON.stringify({ scene }) } },
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
      requested.push({ kind, agent: args.agent.id, scene: args.scene, motion: args.motion, duration: args.duration });
      return { ok: true, attachment };
    } } });
  const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
  const scope = { childId: boot.value.children[0].id, agentId: role.id };
  const body = { ...scope, text: '发段你正在干嘛的视频', requestId: 'role-video-once' };
  const events = [];
  const result = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: boot.snapshot, scope, body },
    { emit: event => events.push(event) });
  assert.deepEqual(requested, [{ kind: 'video', agent: role.id, scene, motion, duration }]);
  assert.deepEqual(events.find(event => event.type === 'character_media')?.attachment, attachment);
  assert.deepEqual(JSON.parse(result.snapshot.tables.messages.find(row => row.role === 'assistant').attachment), attachment);
  const replay = [];
  await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: result.snapshot, scope, body },
    { emit: event => replay.push(event) });
  assert.deepEqual(replay.find(event => event.type === 'character_media')?.attachment, attachment);
  assert.equal(requested.length, 1);
});

test('Pika upload sends the provider-signed headers with the unchanged Qwen frame', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chatlab-signed-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'test-token');
  const portrait = new URL('../public/assets/lin-wanqing-avatar.png', import.meta.url);
  const frame = await readFile(portrait);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const url = new URL(target);
    calls.push(url.pathname);
    switch (url.pathname) {
      case '/api/services/gpu-qwen-image-21/connection':
        return Response.json({ base_url: 'https://test-gpu.example', model: 'qwen-image-2.1' });
      case '/api/assets/images': return Response.json({ asset_id: 'portrait' });
      case '/api/jobs': return Response.json({ job_id: 'frame' });
      case '/api/jobs/frame': return Response.json({ terminal: true, status: 'succeeded' });
      case '/api/jobs/frame/outputs/image/content': return new Response(frame);
      case '/api/services/pika-h3-flex/connection':
        return Response.json({ base_url: 'https://api.dev.pika.art', model: 'pika-h3-flex', headers: { 'X-API-Key': 'test-key' } });
      case '/v1/media/uploads':
        return Response.json({ upload_url: 'https://upload.r2.pika.art/signed', url: 'https://cdn.pika.art/frame.png',
          headers: { 'Content-Type': 'image/png', 'Content-Length': String(frame.length),
            'Cache-Control': 'public, max-age=3600' } });
      case '/signed':
        assert.equal(options.method, 'PUT');
        assert.equal(options.headers.get('Content-Type'), 'image/png');
        assert.equal(options.headers.get('Content-Length'), String(frame.length));
        assert.equal(options.headers.get('Cache-Control'), 'public, max-age=3600');
        assert.equal(options.headers.has('X-API-Key'), false);
        assert.deepEqual(options.body, frame);
        return new Response(null, { status: 200 });
      case '/v1/media/pika/pika-h3-flex/image-to-video':
        assert.equal(JSON.parse(options.body).image, 'https://cdn.pika.art/frame.png');
        assert.equal(JSON.parse(options.body).duration, duration);
        assert.match(JSON.parse(options.body).prompt, /irregular wrist sway/);
        return new Response(null, { status: 422 });
      default: throw new Error('Unexpected test path');
    }
  });
  const media = createCharacterMedia({ tokenFile, directory });
  const agent = { name: '测试角色', metadata: { card: { portrait: '/assets/lin-wanqing-avatar.png' } } };
  const result = await media.generate('video', { agent, scene, motion, duration, runId: 'upload-test',
    signal: new AbortController().signal });
  assert.equal(calls.at(-1), '/v1/media/pika/pika-h3-flex/image-to-video');
  assert.deepEqual(result, { ok: false, error: 'Media service HTTP 422' });
});
