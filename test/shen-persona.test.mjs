import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';

const doc = readFileSync(new URL('../docs/shen-zhiheng-role-setting.md', import.meta.url), 'utf8');
const soul = JSON.parse(readFileSync(new URL('../config/shen-zhiheng.soul.v1.json', import.meta.url), 'utf8'));
const seeds = JSON.parse(readFileSync(new URL('../config/default-agents.json', import.meta.url), 'utf8')).agents;
const seed = seeds.find(x => x.id === 'shen-zhiheng');
const warm = seeds.find(x => x.id === 'lin-wanqing');

test('six-dimension Shen definition is the same complete text in the editable document, SOUL and active seed', () => {
  const text = doc.match(/<!-- definition:start -->\n([\s\S]*?)\n<!-- definition:end -->/)[1];
  assert.equal(soul.definition, text);
  assert.equal(seed.definition, text);
  assert.equal(soul.version, 'cold-persona-plain-v4');
  assert.equal(seed.metadata.catalogDefinitionSha256, createHash('sha256').update(text).digest('hex'));
  for (const heading of ['一 行为镜片', '二 反应规则', '三 表达 DNA', '四 关系算法', '五 决策底线', '六 诚实边界']) assert(text.includes(heading));
  assert.equal(seeds.length, 15);
});

test('an existing managed Shen updates in place, keeps conversations and memories, and private edits are preserved', async () => {
  const legacy = { ...structuredClone(seed), definition: '旧版沈知衡设定。', version: 'legacy' };
  const hash = value => createHash('sha256').update(value).digest('hex');
  legacy.metadata.catalogDefinitionSha256 = hash(legacy.definition);
  const base = { appVersion: 'shen-migration-test', defaultChildren: [{ name: '合成访客', age: 22, interests: [] }],
    model: { configured: true, name: 'mock' }, memoryModel: { configured: true, name: 'mock-memory' },
    provider: { async chat() { return { content: '嗯，你说。', toolCalls: [], receipt: { finish_reason: 'stop' } }; } },
    memoryProvider: { async chat(input) {
      const { userMessages } = JSON.parse(input.messages[1].content);
      return { content: JSON.stringify({ creates: [{ sourceMessageIds: [userMessages[0].id],
        kind: 'understanding', topics: ['电影'], summary: '合成访客喜欢悬疑电影。' }],
        updates: [], mentions: [], retractions: [], overview: null }), receipt: { finish_reason: 'stop' } };
    } } };
  const old = await createBrowserWorkspace({ ...base, defaultAgents: [legacy] }).execute({ method: 'GET', path: '/api/state' });
  const child = old.value.children[0].id;
  const scope = { childId: child, agentId: seed.id };
  const oldWorkspace = createBrowserWorkspace({ ...base, defaultAgents: [legacy] });
  const talked = await oldWorkspace.execute({ method: 'POST', path: '/api/chat', snapshot: old.snapshot, scope,
    body: { ...scope, text: '我喜欢看悬疑电影。', requestId: 'old-conversation' } });
  const opened = await oldWorkspace.execute({ method: 'POST', path: '/api/sessions', snapshot: talked.snapshot, scope, body: scope });
  assert.equal(opened.snapshot.tables.messages.length, 2);
  assert.equal(opened.snapshot.tables.memories.length, 1);
  const before = structuredClone(opened.snapshot);
  const workspace = createBrowserWorkspace({ ...base, defaultAgents: [seed, warm] });
  const result = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: before });
  assert.equal(result.value.agents.length, 2);
  assert.equal(result.value.agents.find(x => x.id === warm.id).definition, warm.definition);
  assert.equal(result.value.agents[0].definition, seed.definition);
  for (const [table, rows] of Object.entries(before.tables)) if (table !== 'agents') assert.deepEqual(result.snapshot.tables[table], rows);
  const edited = structuredClone(before);
  edited.tables.agents[0].definition = '用户手动改写的私人角色。';
  const privateResult = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: edited });
  assert.equal(privateResult.value.agents[0].definition, edited.tables.agents[0].definition);
});


test('Lin Wanqing is a separate adult role with the exact editable prompt and portrait', () => {
  const document = readFileSync(new URL('../docs/lin-wanqing-role-setting.md', import.meta.url), 'utf8');
  const soul = JSON.parse(readFileSync(new URL('../config/lin-wanqing.soul.v1.json', import.meta.url), 'utf8'));
  const definition = document.match(/<!-- definition:start -->\n([\s\S]*?)\n<!-- definition:end -->/)[1];
  assert.equal(soul.definition, definition);
  assert.equal(warm.definition, definition);
  assert.equal(warm.metadata.catalogDefinitionSha256, createHash('sha256').update(definition).digest('hex'));
  assert.equal(warm.metadata.audience.minimumAge, 18);
  assert.equal(warm.version, 'lin-wanqing-v5');
  assert.notEqual(warm.id, seed.id);
  assert.equal(seeds.filter(x => x.id === warm.id).length, 1);
  assert(readFileSync(new URL('../public' + warm.metadata.card.portrait, import.meta.url), 'utf8').includes('<svg'));
});
