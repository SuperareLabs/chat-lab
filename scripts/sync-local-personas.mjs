import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentSeedForSoul } from '../lib/prompts.mjs';

const root = new URL('../', import.meta.url);
const plans = [
  { id: 'shen-zhiheng', document: 'docs/shen-zhiheng-role-setting.md', soul: 'config/shen-zhiheng.soul.v1.json' },
  { id: 'lin-wanqing', document: 'docs/lin-wanqing-role-setting.md', soul: 'config/lin-wanqing.soul.v1.json' },
];
const hash = value => createHash('sha256').update(value).digest('hex');

export function syncLocalPersonas({ ids = plans.map(item => item.id), reviewCopies = {} } = {}) {
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !plans.some(p => p.id === id))) throw new Error('未知或重复的角色ID');
  const seedsFile = new URL('config/default-agents.json', root);
  const seeds = JSON.parse(readFileSync(seedsFile, 'utf8'));
  const prepared = plans.filter(plan => ids.includes(plan.id)).map(plan => {
    const document = readFileSync(new URL(plan.document, root), 'utf8');
    const definition = document.match(/<!-- definition:start -->\n([\s\S]*?)\n<!-- definition:end -->/)?.[1];
    const version = document.match(/版本：`([a-z0-9-]+)`/)?.[1];
    const labels = ['行为镜片', '反应规则', '表达 DNA', '关系算法', '决策底线', '诚实边界'];
    if (!definition || !version || labels.some(label => !definition.includes(label)) || Buffer.byteLength(definition) > 56_000) throw new Error('角色正文不完整或超限：' + plan.id);
    const soul = JSON.parse(readFileSync(new URL(plan.soul, root), 'utf8'));
    if (soul.soulId !== plan.id || soul.schemaVersion !== 2) throw new Error('SOUL的ID或格式不符：' + plan.id);
    soul.definition = definition; soul.version = version;
    let seed = seeds.agents.find(agent => agent.id === plan.id);
    if (seed && seed.name !== soul.name) throw new Error('角色名称不一致：' + plan.id);
    if (!seed) {
      seed = agentSeedForSoul({ ...soul, identity: { name: soul.name, role: soul.card.role } });
      seeds.agents.push(seed);
    }
    const previous = new Set(seed.metadata.catalogPreviousDefinitionSha256 ?? []);
    if (seed.definition !== definition) previous.add(hash(seed.definition));
    seed.definition = definition; seed.version = version;
    seed.metadata.catalogPreviousDefinitionSha256 = [...previous];
    seed.metadata.catalogDefinitionSha256 = hash(definition);
    return { plan, document, soul, seed };
  });
  for (const { plan, document, soul } of prepared) {
    writeFileSync(new URL(plan.soul, root), JSON.stringify(soul, null, 2) + '\n');
    if (reviewCopies[plan.id]) writeFileSync(reviewCopies[plan.id], document);
  }
  writeFileSync(seedsFile, JSON.stringify(seeds, null, 2) + '\n');
  return { roles: prepared.map(({ seed }) => ({ id: seed.id, name: seed.name, version: seed.version,
    bytes: Buffer.byteLength(seed.definition), sha256: hash(seed.definition) })), totalAgents: seeds.agents.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(syncLocalPersonas()));
}
