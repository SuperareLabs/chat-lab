import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { COMMON_PROMPT, loadSouls, renderSoul, soulCard } from '../lib/prompts.mjs';

const definitionSoul = () => ({ schemaVersion: 2, soulId: 'definition-fixture', version: 'fixture-v1',
  name: '  灯灯  ', definition: '\n你是陪人聊天的灯灯。\n\n  第二段保留内部缩进。\n' });

async function loadFixture(t, records) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-lab-soul-definition-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [index, record] of records.entries()) {
    await writeFile(join(directory, `${index}.soul.v1.json`), JSON.stringify(record));
  }
  return loadSouls(pathToFileURL(directory + sep));
}

test('schema 2 accepts only name and definition as role text while preserving internal formatting', async t => {
  const record = definitionSoul();
  const loaded = await loadFixture(t, [record]);
  const soul = loaded.get(record.soulId);
  assert.equal(soul.soulId, record.soulId);
  assert.equal(soul.name, '灯灯');
  assert.equal(soul.definition, '你是陪人聊天的灯灯。\n\n  第二段保留内部缩进。');
  assert.deepEqual(soul.identity, { name: '灯灯', aliases: [], role: '', relationship: '' });
  assert.deepEqual(soul.specialties, []);
  assert.equal(renderSoul(soul), `${COMMON_PROMPT}\n\n【名称】灯灯\n【角色设定】${record.definition.trim()}`);
});

test('schema 2 display metadata and retired split fields never become hidden prompt instructions', async t => {
  const record = { ...definitionSoul(),
    identity: { name: '旧名字不得回注', aliases: ['旧别名不得回注'], role: '旧身份不得回注', relationship: '旧关系不得回注' },
    personality: '旧性格不得回注', speakingStyle: '旧说话不得回注', replyStyle: '旧接话不得回注',
    specialties: ['旧擅长不得回注'], worldview: '旧世界观不得回注', background: '旧背景不得回注', dailyLife: '旧日常不得回注',
    card: { role: '展示身份', relationship: '展示关系', aliases: ['展示别名'], specialties: ['展示擅长'],
      personality: '展示性格', speakingStyle: '展示说话', replyStyle: '展示接话', worldview: '展示世界观',
      background: '展示背景', dailyLife: '展示日常', theme: 'fern', portrait: '/assets/pinecone.svg' },
  };
  const soul = (await loadFixture(t, [record])).get(record.soulId);
  assert.deepEqual(soul.identity, { name: '灯灯', aliases: ['展示别名'], role: '展示身份', relationship: '展示关系' });
  assert.deepEqual(soul.specialties, ['展示擅长']);
  const card = soulCard(soul);
  assert.deepEqual(card.identity, soul.identity);
  assert.deepEqual(card.specialties, ['展示擅长']);
  assert.equal(card.personality, '展示性格');
  assert.equal(card.portrait, '/assets/pinecone.svg');
  assert.equal(renderSoul(soul), `${COMMON_PROMPT}\n\n【名称】灯灯\n【角色设定】${record.definition.trim()}`);
});

test('schema 2 refuses missing or blank required fields and duplicate IDs', async t => {
  for (const field of ['soulId', 'version', 'name', 'definition']) {
    const missing = definitionSoul();
    delete missing[field];
    await assert.rejects(loadFixture(t, [missing]), /SOUL 配置无效/);
    await assert.rejects(loadFixture(t, [{ ...definitionSoul(), [field]: ' \n ' }]), /SOUL 配置无效/);
  }
  for (const field of ['name', 'definition']) {
    await assert.rejects(loadFixture(t, [{ ...definitionSoul(), [field]: 123 }]), /SOUL 配置无效/);
  }
  await assert.rejects(loadFixture(t, [{ ...definitionSoul(), soulId: ' padded-id ' }]), /SOUL 配置无效/);
  await assert.rejects(loadFixture(t, [definitionSoul(), definitionSoul()]), /SOUL 配置无效或 ID 重复/);
});

test('schema 2 validates display metadata types without making it required', async t => {
  for (const card of [null, [], { role: 7 }, { relationship: false }, { aliases: '灯灯' },
    { aliases: [' '] }, { specialties: [123] }, { personality: '' }, { portrait: '../private.png' }]) {
    await assert.rejects(loadFixture(t, [{ ...definitionSoul(), card }]), /SOUL 配置无效/);
  }
  const soul = (await loadFixture(t, [{ ...definitionSoul(), card: { role: '', relationship: '', aliases: [], specialties: [] } }]))
    .get('definition-fixture');
  assert.deepEqual(soul.identity, { name: '灯灯', aliases: [], role: '', relationship: '' });
});

test('the migrated crocodile retains its original scope ID and uses the complete definition', () => {
  const originalId = '9a15fadb-1fa5-437d-aeee-6f2a3e1e8d65';
  const soul = loadSouls().get(originalId);
  assert(soul);
  assert.equal(soul.schemaVersion, 2);
  assert.equal(soul.version, 'croco-ai-mentor-v3');
  assert.equal(soul.name, '鳄鱼爸爸');
  assert.equal(soul.identity.name, soul.name);
  assert.equal(renderSoul(soul), `${COMMON_PROMPT}\n\n【名称】${soul.name}\n【角色设定】${soul.definition}`);
});

test('Pinecone keeps its exact schema-1 role bytes while Lin Xiaoman uses the complete schema-2 definition', () => {
  // Freeze the role bytes; shared chat guidance is maintained independently.
  const expected = new Map([
    ['pinecone-lab', '96a2dbb70e9c0c4452387e1471e35e21e4db08c5e16177b0489107527cbe9781'],
  ]);
  const souls = loadSouls();
  for (const [id, hash] of expected) {
    const soul = souls.get(id);
    assert.equal(soul.schemaVersion, 1);
    assert.equal(createHash('sha256').update(renderSoul(soul).slice(COMMON_PROMPT.length + 2)).digest('hex'), hash);
  }
  const lin = souls.get('lin-xiaoman');
  assert.equal(lin.schemaVersion, 2);
  assert.equal(lin.audience.minimumAge, 18);
  assert.equal(renderSoul(lin), `${COMMON_PROMPT}\n\n【名称】${lin.name}\n【角色设定】${lin.definition}`);
});
