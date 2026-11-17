import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readCharacterReference } from '../lib/character-reference.mjs';
import { availableTools, makeToolRunner } from '../lib/tools.mjs';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';
import { COMMON_PROMPT } from '../lib/prompts.mjs';

const pack = JSON.parse(readFileSync(new URL('../character-packs/nuwa-20261116/characters.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../character-packs/nuwa-20261116/source-manifest.json', import.meta.url), 'utf8'));

test('five actual role definitions contain the complete byte-verified upstream SKILL without deletions', () => {
  assert.equal(pack.agents.length, 5);
  for (const agent of pack.agents) {
    const record = manifest.files.find(file => file.sourcePath === agent.metadata.nuwaSource.path);
    const bytes = readFileSync(new URL('../' + record.path, import.meta.url));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(blob, record.gitBlob);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
    const original = bytes.toString('utf8');
    assert(agent.definition.includes(original), agent.name);
    assert.equal(agent.definition.indexOf(original), agent.definition.lastIndexOf(original));
    assert.equal(agent.metadata.nuwaSource.adaptationVersion, 'source-preserving-v3');
    assert(Buffer.byteLength(agent.definition) <= 56_000);
    assert(agent.definition.includes('【ChatLab 架构适配段｜本地新增，非 Nuwa 原文】'));
  }
});

test('reference reading resolves a real case and pages original voice text within bounds', () => {
  const index = readCharacterReference('nuwa-steve-jobs', { path: '__index__' });
  assert(index.paths.includes('references/casebook.md'));
  assert(index.paths.includes('references/voice.md'));
  const card = readCharacterReference('nuwa-steve-jobs', { path: 'references/casebook.md', section: 'C05' });
  assert.equal(card.status, 'found');
  assert.match(card.content, /1997.*四格/);
  assert.match(card.sourceUrl, /73b6f2d.*steve-jobs-perspective/);
  assert(!card.content.includes('## C06'));
  const first = readCharacterReference('nuwa-munger', { path: 'references/voice.md', lineCount: 3 });
  const next = readCharacterReference('nuwa-munger', { path: 'references/voice.md', startLine: first.nextStartLine, lineCount: 3 });
  assert.equal(first.truncated, true);
  assert.equal(next.startLine, first.endLine + 1);
  assert(first.content.length <= 12000);
});

test('reference tool cannot select another role, traverse paths or read omitted evaluation material', async () => {
  assert(!availableTools(null, 'shen-zhiheng').some(x => x.function.name === 'read_character_reference'));
  assert(availableTools(null, 'nuwa-sun-yuchen').some(x => x.function.name === 'read_character_reference'));
  for (const path of ['/etc/passwd', '../config/runtime.env', 'references/../../data/public-catalog.sqlite', 'references\\voice.md']) {
    assert.equal(readCharacterReference('nuwa-munger', { path }).status, 'invalid');
  }
  assert.equal(readCharacterReference('nuwa-sun-yuchen', { path: 'references/casebook.md' }).status, 'not_found');
  assert.equal(readCharacterReference('nuwa-munger', { path: 'references/research/holdout.md' }).status, 'not_found');
  assert.equal(readCharacterReference('nuwa-munger', { path: 'references/voice.md', lineCount: 121 }).status, 'invalid');
  const signal = new AbortController().signal;
  const runner = makeToolRunner({ store: {}, run: { agentId: 'nuwa-sun-yuchen' }, signal });
  assert.equal((await runner('read_character_reference', { path: '__index__', agentId: 'nuwa-munger' })).status, 'invalid');
});

test('chat runtime carries the full source and completes a real reference-tool roundtrip', async () => {
  const seed = pack.agents.find(agent => agent.id === 'nuwa-steve-jobs');
  let calls = 0;
  const workspace = createBrowserWorkspace({ appVersion: 'source-test', defaultAgents: [seed],
    defaultChildren: [{ name: '合成访客', age: 22, interests: [] }],
    model: { name: 'test', configured: true, thinking: 'enabled', reasoningEffort: 'low' },
    memoryModel: { configured: false, name: 'disabled' },
    provider: { async chat(input) {
      calls++;
      assert(input.messages[0].content.includes(seed.definition));
      assert(input.tools.some(x => x.function.name === 'read_character_reference'));
      if (calls === 1) return { content: '', toolCalls: [{ id: 'ref1', type: 'function', function: {
        name: 'read_character_reference', arguments: JSON.stringify({ path: 'references/casebook.md', section: 'C05' }) } }], receipt: { finish_reason: 'tool_calls' } };
      const evidence = JSON.parse(input.messages.findLast(x => x.role === 'tool').content);
      assert.equal(evidence.status, 'found');
      assert.match(evidence.content, /四格/);
      return { content: '当时把产品线收进四个格子。', toolCalls: [], receipt: { finish_reason: 'stop' } };
    } } });
  const initial = await workspace.execute({ method: 'GET', path: '/api/state' });
  const scope = { childId: initial.value.children[0].id, agentId: seed.id };
  const result = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: initial.snapshot, scope,
    body: { ...scope, text: '四格产品线是怎么回事？', requestId: 'reference-test' } });
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test('public upstream quotations are allowed while common policy copying is still blocked', async () => {
  const seed = pack.agents.find(agent => agent.id === 'nuwa-steve-jobs');
  const record = manifest.files.find(file => file.sourcePath === seed.metadata.nuwaSource.path);
  const original = readFileSync(new URL('../' + record.path, import.meta.url), 'utf8');
  const quote = original.match(/^我在乎的事不多：.*$/m)[0];
  for (const [reply, allowed] of [[quote, true], [COMMON_PROMPT.slice(0, 80), false]]) {
    const workspace = createBrowserWorkspace({ appVersion: 'quote-test', defaultAgents: [seed],
      defaultChildren: [{ name: '合成访客', age: 22, interests: [] }],
      model: { configured: true, name: 'test' }, memoryModel: { configured: false, name: 'disabled' },
      provider: { async chat() { return { content: reply, toolCalls: [], receipt: { finish_reason: 'stop' } }; } } });
    const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
    const scope = { childId: boot.value.children[0].id, agentId: seed.id };
    const result = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: boot.snapshot, scope,
      body: { ...scope, text: '聊聊你在乎什么', requestId: 'quote-check' } });
    const shown = result.snapshot.tables.messages.findLast(row => row.role === 'assistant').text;
    assert.equal(shown.includes(reply), allowed);
  }
});
