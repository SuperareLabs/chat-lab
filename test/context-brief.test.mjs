import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_BRIEF_VERSION, CONTEXT_BRIEF_PROMPT, briefFingerprint, briefRequestFor,
  validateBriefOutput, renderContextBrief } from '../lib/context-brief.mjs';

const records = [
  { id: 'm-1', kind: 'understanding', state: 'active', summary: '用户有学习英语的需求，曾主动向AI询问英语学习方法。' },
  { id: 'm-2', kind: 'understanding', state: 'active', summary: '用户常玩《英雄联盟》（简称LoL）。' },
  { id: 'm-3', kind: 'understanding', state: 'active', summary: '用户近期正在学习英语，希望通过英语电影辅助学习，并希望按1到10的难度梯度推荐电影。' },
];
const group = (category, representativeId, memberIds = [representativeId]) => ({ category, representativeId, memberIds });
const wire = () => ({ groups: [group('goals', 'S3', ['S1', 'S3']), group('preferences', 'S2')], deferredIds: [] });
const validate = output => validateBriefOutput(JSON.stringify(output), records);

test('context brief uses a separate version and only sends stable source aliases', () => {
  assert.equal(CONTEXT_BRIEF_VERSION, 1);
  assert.match(CONTEXT_BRIEF_PROMPT, /不改写、补充或删除原记忆/);
  const request = briefRequestFor([...records].reverse());
  const payload = JSON.parse(request.messages[1].content);
  assert.deepEqual(payload.records.map(record => record.id), ['S1', 'S2', 'S3']);
  assert.deepEqual(payload.records.map(record => record.summary), records.map(record => record.summary));
  assert(!request.messages[1].content.includes('m-1'));
  assert.equal(request.responseFormat.json_schema.name, 'context_brief_selection_v1');
  assert.equal(request.responseFormat.json_schema.strict, true);
  assert.equal(briefRequestFor([]), null);
});

test('three overlapping memories render as two original facts without rewriting any memory', () => {
  const before = structuredClone(records);
  const selection = validate(wire());
  const result = renderContextBrief(selection, records);
  assert.deepEqual(result.memoryIds, ['m-3', 'm-2']);
  assert.deepEqual(result.coveredMemoryIds, ['m-1', 'm-3', 'm-2']);
  assert.deepEqual(result.deferredMemoryIds, []);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.itemCount, 2);
  assert.equal(result.summary, `【目标】\n${records[2].summary}\n【偏好】\n${records[1].summary}`);
  assert(!result.summary.includes(records[0].summary));
  assert.deepEqual(records, before);
  const textOnly = result.summary.split('\n').filter(line => !line.startsWith('【'));
  assert(textOnly.every(line => records.some(record => record.summary === line)), 'every fact is an entire source summary');
});

test('fingerprint is input-order stable and ignores mention/version/archive-only changes', () => {
  const original = briefFingerprint(records, { modelName: 'lite' });
  const touched = [...records].reverse().map(record => ({ ...record, state: 'archived',
    version: 123, lastMentionedAt: '2099-01-01', scopeRevision: 99 }));
  assert.equal(briefFingerprint(touched, { modelName: 'lite' }), original);
  assert.notEqual(briefFingerprint([{ ...records[0], summary: '用户不再学习英语。' }, ...records.slice(1)], { modelName: 'lite' }), original);
  assert.notEqual(briefFingerprint(records, { modelName: 'other-model' }), original);
  assert.notEqual(briefFingerprint(records.slice(1), { modelName: 'lite' }), original);
  assert.deepEqual(validateBriefOutput(JSON.stringify(wire()), [...records].reverse()), validate(wire()));
});

test('500 sources stay fully accounted for as lower-priority candidates fill the available budget', () => {
  const many = Array.from({ length: 500 }, (_, index) => ({ id: 'm-' + String(index).padStart(3, '0'),
    kind: 'understanding', summary: `第${index}条明确的长期了解。` }));
  const request = briefRequestFor(many);
  const refs = JSON.parse(request.messages[1].content).records.map(record => record.id);
  const output = { groups: [group('background', refs[0])], deferredIds: refs.slice(1) };
  const selection = validateBriefOutput(JSON.stringify(output), many);
  const result = renderContextBrief(selection, many);
  assert.equal(selection.deferredIds.length, 499);
  assert.equal(result.sourceCount, 500);
  assert.equal(result.itemCount, 90);
  assert.equal(result.deferredMemoryIds.length, 410);
  assert.match(result.summary, /另有410条长期了解可按需查询。$/);
  assert(result.summary.length <= 1200);
  assert.equal(new Set([...result.coveredMemoryIds, ...result.deferredMemoryIds]).size, 500);
});

test('unknown, duplicate, missing and mis-grouped model references are rejected', () => {
  const bad = [
    { groups: [group('goals', 'S999')], deferredIds: ['S1', 'S2', 'S3'] },
    { groups: [group('goals', 'm-1')], deferredIds: ['S2', 'S3'] },
    { groups: [group('goals', 'S1', ['S1', 'S1'])], deferredIds: ['S2', 'S3'] },
    { groups: [group('goals', 'S1')], deferredIds: ['S1', 'S2', 'S3'] },
    { groups: [group('goals', 'S1')], deferredIds: ['S2'] },
    { groups: [group('goals', 'S1', ['S2'])], deferredIds: ['S1', 'S3'] },
    { groups: [group('unknown', 'S1')], deferredIds: ['S2', 'S3'] },
    { groups: [group('goals', 'S1', [])], deferredIds: ['S2', 'S3'] },
    { groups: [], deferredIds: ['S1', 'S2', 'S3'], summary: '模型编造的正文。' },
    { groups: [{ ...group('goals', 'S1'), summary: '额外正文。' }], deferredIds: ['S2', 'S3'] },
  ];
  for (const output of bad) assert.throws(() => validate(output));
});

test('budget keeps whole source statements and accounts for every omitted group member', () => {
  const sources = [
    { id: 'a', kind: 'understanding', summary: '第一条' + '完整信息'.repeat(100) + '。' },
    { id: 'b', kind: 'understanding', summary: '用户喜欢短回复。' },
    { id: 'c', kind: 'understanding', summary: '第三条' + '完整信息'.repeat(100) + '。' },
  ];
  const selection = { groups: [group('goals', 'a', ['a', 'c']), group('interaction', 'b')], deferredIds: [] };
  const result = renderContextBrief(selection, sources, { budget: 60 });
  assert.equal(result.memoryIds.join(','), 'b');
  assert.deepEqual(result.deferredMemoryIds, ['a', 'c']);
  assert.match(result.summary, /用户喜欢短回复。/);
  assert.match(result.summary, /另有2条长期了解可按需查询。$/);
  assert(!result.summary.includes('完整信息'));
  assert(result.summary.length <= 60);
  const tiny = renderContextBrief(null, [sources[1]], { budget: 0 });
  assert.equal(tiny.summary, '');
  assert.deepEqual(tiny.deferredMemoryIds, ['b']);
  assert.equal(tiny.itemCount, 0);
  for (const budget of [-1, 1.5, NaN, Infinity]) assert.throws(() => renderContextBrief(null, sources, { budget }));
});

test('negative and complementary statements remain exactly as selected without new connective facts', () => {
  const sources = [
    { id: 'a', kind: 'understanding', summary: '用户不喝咖啡。' },
    { id: 'b', kind: 'understanding', summary: '用户喜欢无糖红茶。' },
    { id: 'c', kind: 'understanding', summary: '用户去年曾计划学习法语，是否继续未知。' },
  ];
  const selection = { groups: [group('preferences', 'a'), group('preferences', 'b'), group('goals', 'c')], deferredIds: [] };
  const result = renderContextBrief(selection, sources);
  assert.equal(result.summary, '【偏好】\n用户不喝咖啡。\n用户喜欢无糖红茶。\n【目标】\n用户去年曾计划学习法语，是否继续未知。');
  assert.equal(result.itemCount, 3);
});

test('fallback order is stable and invalid source kinds or states cannot enter a projection', () => {
  assert.deepEqual(renderContextBrief(null, records), renderContextBrief(undefined, [...records].reverse()));
  assert.deepEqual(renderContextBrief(null, []), { summary: '', memoryIds: [], coveredMemoryIds: [],
    deferredMemoryIds: [], groups: [], sourceCount: 0, itemCount: 0 });
  for (const invalid of [
    [{ ...records[0], kind: 'event' }], [{ ...records[0], state: 'retracted' }],
    [{ ...records[0], summary: ' ' }], [{ ...records[0], id: '' }], [records[0], records[0]],
  ]) {
    assert.throws(() => briefFingerprint(invalid));
    assert.throws(() => briefRequestFor(invalid));
    assert.throws(() => renderContextBrief(null, invalid));
  }
});

test('renderer rejects forged cached references and request schema mutations stay isolated', () => {
  assert.throws(() => renderContextBrief({ groups: [group('goals', 'outside')], deferredIds: [] }, records));
  assert.throws(() => renderContextBrief({ groups: [group('goals', 'm-1')], deferredIds: ['m-2'] }, records));
  const request = briefRequestFor(records);
  request.responseFormat.json_schema.schema.properties.groups.items.properties.category.enum.push('forged');
  assert.throws(() => validate({ groups: [group('forged', 'S1')], deferredIds: ['S2', 'S3'] }));
  assert(!briefRequestFor(records).responseFormat.json_schema.schema.properties.groups.items.properties.category.enum.includes('forged'));
});

test('quoted independent preferences split a false group while a genuine English overlap stays grouped', () => {
  const sources = [
    { id: 'a', kind: 'understanding', summary: '用户对古诗词有学习兴趣，偏好按“诗人生平—履历—代表作背景与含义”的方式理解诗人与作品。' },
    { id: 'b', kind: 'understanding', summary: '用户常玩《英雄联盟》（简称LoL）。' },
    { id: 'c', kind: 'understanding', summary: '用户有学习英语的需求，曾主动向AI询问英语学习方法。' },
    { id: 'd', kind: 'understanding', summary: '用户在古诗词方面偏好“霸气外露”的风格。' },
    { id: 'e', kind: 'understanding', summary: '用户近期正在学习英语，希望通过英语电影辅助学习，并希望按1-10的难度梯度推荐电影。' },
  ];
  const raw = { groups: [group('preferences', 'S2'), group('preferences', 'S1', ['S1', 'S4']),
    group('goals', 'S5', ['S3', 'S5'])], deferredIds: [] };
  const selection = validateBriefOutput(JSON.stringify(raw), sources);
  assert.equal(selection.groups.length, 4);
  assert.deepEqual(selection.groups[1].memberIds, ['a']);
  assert.deepEqual(selection.groups[2], group('preferences', 'd'));
  assert.deepEqual(selection.groups[3].memberIds, ['c', 'e']);
  const view = renderContextBrief(selection, sources);
  assert.equal(view.itemCount, 4);
  assert(view.summary.includes('“霸气外露”'));
  assert(view.summary.includes('“诗人生平—履历—代表作背景与含义”'));
  assert(view.summary.includes('1-10'));
  assert(!view.summary.includes(sources[2].summary));
  assert.equal(view.coveredMemoryIds.length, 5);
  // Persisted selections written before this guard get the same protection.
  const cached = { groups: [group('preferences', 'b'), group('preferences', 'a', ['a', 'd']),
    group('goals', 'e', ['c', 'e'])], deferredIds: [] };
  assert.deepEqual(renderContextBrief(cached, sources), view);
});

test('unrepresented numeric ranges, exact numbers and titles remain separate facts', () => {
  const cases = [
    ['用户希望按1-10级推荐材料。', '用户正在学习这门语言。'],
    ['用户每次练习10分钟。', '用户每次练习100分钟。'],
    ['用户预算为20-30万。', '用户预算为120-300万。'],
    ['用户喜欢《海边来信》。', '用户喜欢海边故事。'],
    ['用户偏好"slow mode"。', '用户偏好简短回复。'],
  ];
  for (const [specific, general] of cases) {
    const sources = [{ id: 'a', kind: 'understanding', summary: specific },
      { id: 'b', kind: 'understanding', summary: general }];
    const selection = validateBriefOutput(JSON.stringify({ groups: [group('preferences', 'S2', ['S1', 'S2'])], deferredIds: [] }), sources);
    assert.equal(selection.groups.length, 2);
    assert(renderContextBrief(selection, sources).summary.includes(specific));
    assert.equal(renderContextBrief({ groups: [group('preferences', 'b', ['a', 'b'])], deferredIds: [] }, sources).itemCount, 2);
  }
  const sources = [{ id: 'a', kind: 'understanding', summary: '用户希望按1-10级选材料。' },
    { id: 'b', kind: 'understanding', summary: '用户希望按1到10级选材料，同时保留原文。' }];
  const selection = validateBriefOutput(JSON.stringify({ groups: [group('goals', 'S2', ['S1', 'S2'])], deferredIds: [] }), sources);
  assert.equal(selection.groups.length, 1, 'typographic range variants preserve the same literal range');
});

test('negation constraints stay separate unless the entire normalized statement is present', () => {
  for (const negative of ['用户不喝咖啡。', '用户没有报名比赛。', 'User does not drink coffee.', "User doesn't drink coffee."]) {
    const sources = [{ id: 'a', kind: 'understanding', summary: negative },
      { id: 'b', kind: 'understanding', summary: '用户喜欢红茶。' }];
    const selection = validateBriefOutput(JSON.stringify({ groups: [group('preferences', 'S2', ['S1', 'S2'])], deferredIds: [] }), sources);
    assert.equal(selection.groups.length, 2);
    assert(renderContextBrief(selection, sources).summary.includes(negative));
  }
  const sources = [{ id: 'a', kind: 'understanding', summary: '用户不喝咖啡。' },
    { id: 'b', kind: 'understanding', summary: '用户不喝咖啡，还喜欢无糖红茶。' }];
  const selection = validateBriefOutput(JSON.stringify({ groups: [group('preferences', 'S2', ['S1', 'S2'])], deferredIds: [] }), sources);
  assert.equal(selection.groups.length, 1);
  assert.equal(renderContextBrief(selection, sources).itemCount, 1);
});

test('independent facts marked deferred still appear when the budget can hold them', () => {
  const sources = [
    { id: 'a', kind: 'understanding', summary: '用户正在通过电影学习英语。' },
    { id: 'b', kind: 'understanding', summary: '用户常玩《英雄联盟》。' },
    { id: 'c', kind: 'understanding', summary: '用户偏好“霸气外露”的诗词风格。' },
  ];
  const selection = validateBriefOutput(JSON.stringify({ groups: [group('goals', 'S1')], deferredIds: ['S2', 'S3'] }), sources);
  const view = renderContextBrief(selection, sources);
  assert.equal(view.itemCount, 3);
  assert.equal(view.sourceCount, 3);
  assert.deepEqual(view.memoryIds, ['a', 'b', 'c']);
  assert.deepEqual(view.coveredMemoryIds, ['a', 'b', 'c']);
  assert.deepEqual(view.deferredMemoryIds, []);
  for (const source of sources) assert(view.summary.includes(source.summary));
  assert(!view.summary.includes('另有'));
  assert.equal(view.groups[1].category, 'other');
});

test('budget deferral follows priority and never clips a lower-priority original statement', () => {
  const sources = [
    { id: 'a', kind: 'understanding', summary: '用户喜欢短回复。' },
    { id: 'b', kind: 'understanding', summary: '用户独立偏好' + '明确约束'.repeat(40) + '。' },
    { id: 'c', kind: 'understanding', summary: '用户常玩《英雄联盟》。' },
  ];
  const selection = validateBriefOutput(JSON.stringify({ groups: [group('interaction', 'S1')], deferredIds: ['S2', 'S3'] }), sources);
  const view = renderContextBrief(selection, sources, { budget: 75 });
  assert.deepEqual(view.memoryIds, ['a', 'c']);
  assert.deepEqual(view.deferredMemoryIds, ['b']);
  assert(view.summary.includes(sources[0].summary));
  assert(view.summary.includes(sources[2].summary));
  assert(!view.summary.includes('明确约束'));
  assert.match(view.summary, /另有1条长期了解可按需查询。$/);
  assert(view.summary.length <= 75);
});
