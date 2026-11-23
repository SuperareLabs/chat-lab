import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';

const role = { id: 'test-role', name: '角色', definition: '自然聊天。', metadata: { card: { portrait: '/assets/test.png' } } };
const attachment = { id: 'a'.repeat(48), kind: 'video' };
const motion = '她拿起刚泡好的咖啡，抿一口。';
const scene = '她坐在厨房窗边，手放在咖啡杯旁。';

test('character video is delivered and replayed without another media generation', async () => {
  const requested = [];
  let rounds = 0;
  const provider = {
    async chat({ tools, messages }) {
      rounds++;
      assert(tools.some(tool => tool.function.name === 'send_character_video'));
      if (rounds === 1) return { content: '', toolCalls: [
        { id: 'video', type: 'function', function: { name: 'send_character_video', arguments: JSON.stringify({ scene, motion }) } },
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
      requested.push({ kind, agent: args.agent.id, scene: args.scene, motion: args.motion });
      return { ok: true, attachment };
    } } });
  const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
  const scope = { childId: boot.value.children[0].id, agentId: role.id };
  const body = { ...scope, text: '发段你正在干嘛的视频', requestId: 'role-video-once' };
  const events = [];
  const result = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: boot.snapshot, scope, body },
    { emit: event => events.push(event) });
  assert.deepEqual(requested, [{ kind: 'video', agent: role.id, scene, motion }]);
  assert.deepEqual(events.find(event => event.type === 'character_media')?.attachment, attachment);
  assert.deepEqual(JSON.parse(result.snapshot.tables.messages.find(row => row.role === 'assistant').attachment), attachment);
  const replay = [];
  await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: result.snapshot, scope, body },
    { emit: event => replay.push(event) });
  assert.deepEqual(replay.find(event => event.type === 'character_media')?.attachment, attachment);
  assert.equal(requested.length, 1);
});
