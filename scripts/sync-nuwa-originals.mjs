import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const folder = 'character-packs/nuwa-20261116/';
const manifest = JSON.parse(readFileSync(new URL(folder + 'source-manifest.json', root), 'utf8'));
const packFile = new URL(folder + 'characters.json', root);
const defaultsFile = new URL('config/default-agents.json', root);
const pack = JSON.parse(readFileSync(packFile, 'utf8'));
const defaults = JSON.parse(readFileSync(defaultsFile, 'utf8'));
const adapterSource = readFileSync(new URL(folder + 'ADAPTATION.md', root), 'utf8');
const adapter = adapterSource.match(/<!-- adapter:start -->\s*([\s\S]*?)\s*<!-- adapter:end -->/)?.[1];
if (!adapter) throw new Error('缺少标记明确的适配段');
const people = [
  ['nuwa-feynman', 'feynman', '费曼', '理查德·费曼'],
  ['nuwa-munger', 'munger', '芒格', '查理·芒格'],
  ['nuwa-steve-jobs', 'steve-jobs', '乔布斯', '史蒂夫·乔布斯'],
  ['nuwa-zhang-yiming', 'zhang-yiming', '张一鸣', '张一鸣'],
  ['nuwa-sun-yuchen', 'sun-yuchen', '孙宇晨', '孙宇晨'],
];
const hash = text => createHash('sha256').update(text).digest('hex');
const report = { version: 'source-preserving-v3', commit: manifest.commit,
  adapter: folder + 'ADAPTATION.md', sourceEdits: [], roles: [] };
mkdirSync(new URL(folder + 'roles/', root), { recursive: true });
mkdirSync(new URL(folder + 'changes/', root), { recursive: true });
for (const [id, short, name, person] of people) {
  const slug = short + '-perspective';
  const sourcePath = `examples/${slug}/SKILL.md`;
  const sourceRecord = manifest.files.find(file => file.sourcePath === sourcePath);
  if (!sourceRecord) throw new Error('原文索引缺失：' + sourcePath);
  const originalBytes = readFileSync(new URL(sourceRecord.path, root));
  const original = originalBytes.toString('utf8');
  const blob = createHash('sha1').update(`blob ${originalBytes.length}\0`).update(originalBytes).digest('hex');
  if (hash(originalBytes) !== sourceRecord.sha256 || blob !== sourceRecord.gitBlob) throw new Error('原文校验失败：' + sourcePath);
  const definition = adapter + '\n\n【Nuwa 原文区开始｜以下全文未改写】\n' + original + '\n【Nuwa 原文区结束】';
  if (!definition.includes(original) || Buffer.byteLength(definition) > 56_000) throw new Error('正文未完整保留或超限：' + id);
  const old = pack.agents.find(agent => agent.id === id);
  const aliases = new Set(old?.metadata.catalogPreviousNames ?? []);
  if (old && old.name !== name) aliases.add(old.name);
  const previous = new Set(old?.metadata.catalogPreviousDefinitionSha256 ?? []);
  if (old && old.definition !== definition) previous.add(hash(old.definition));
  const references = manifest.files.filter(file => file.sourcePath.startsWith(`examples/${slug}/references/`));
  const url = `https://github.com/alchaincyf/nuwa-skill/blob/${manifest.commit}/${sourcePath}`;
  const rolePromptFile = `${folder}roles/${short}.md`;
  const agent = { id, name, definition, version: 'nuwa-original-v3', metadata: {
    ...old?.metadata,
    description: 'Nuwa 原文完整接入的 AI 人物角色，非本人或机构授权。',
    card: { ...old?.metadata.card, theme: old?.metadata.card?.theme ?? 'fern',
      portrait: old?.metadata.card?.portrait ?? '/assets/nuwa-sun-yuchen-avatar.svg',
      role: name + ' · Nuwa原文角色', relationship: '依 Nuwa 原文设定与实际交流',
      aliases: old?.metadata.card?.aliases ?? [person],
      personality: '完整保留 Nuwa 原文中的人物特征、矛盾与边界。',
      speakingStyle: '依原文表达 DNA、语气、节奏和示例。',
      replyStyle: '依原文角色与回答规则；ChatLab必要适配单独标注。' },
    catalogPreviousNames: [...aliases], catalogPreviousDefinitionSha256: [...previous], catalogDefinitionSha256: hash(definition),
    nuwaSource: { repository: 'alchaincyf/nuwa-skill', commit: manifest.commit, path: sourcePath, url,
      adaptationVersion: 'source-preserving-v3', rolePromptFile, adapterFile: folder + 'ADAPTATION.md',
      sourceSha256: sourceRecord.sha256, gitBlob: blob, sourceEdits: [], sourceFullyRetained: true,
      referenceFiles: references.map(file => file.sourcePath.slice(`examples/${slug}/`.length)),
      author: 'Huashu (花叔)', license: 'MIT' },
  } };
  const index = pack.agents.findIndex(item => item.id === id);
  if (index < 0) pack.agents.push(agent); else pack.agents[index] = agent;
  const defaultIndex = defaults.agents.findIndex(item => item.id === id);
  if (defaultIndex < 0) defaults.agents.push(structuredClone(agent)); else defaults.agents[defaultIndex] = structuredClone(agent);
  writeFileSync(new URL(rolePromptFile, root), `# ${name}运行设定：Nuwa 原文主体\n\n来源：[固定版本原文](${url})。原文 SHA-256：\`${sourceRecord.sha256}\`。\n\n新增内容只有明确标记的 ChatLab 适配段；原文区完整保留。\n\n<!-- definition:start -->\n${definition}\n<!-- definition:end -->\n`);
  const diff = spawnSync('diff', ['-u', '-L', sourcePath, '-L', 'ChatLab/' + short, fileURLToPath(new URL(sourceRecord.path, root)), '-'],
    { input: definition, encoding: 'utf8', maxBuffer: 128 * 1024 });
  if (![0, 1].includes(diff.status)) throw new Error('无法生成可审阅diff：' + id);
  const diffPath = folder + `changes/${short}.diff`;
  writeFileSync(new URL(diffPath, root), diff.stdout);
  report.roles.push({ id, name, sourcePath, rolePromptFile, diffPath, sourceSha256: sourceRecord.sha256,
    sourceBytes: originalBytes.length, definitionBytes: Buffer.byteLength(definition), sourceCharacters: original.length,
    originalFullyPresent: definition.includes(original), removedSourceCharacters: 0, referenceFiles: references.length });
}
writeFileSync(packFile, JSON.stringify(pack, null, 2) + '\n');
writeFileSync(defaultsFile, JSON.stringify(defaults, null, 2) + '\n');
writeFileSync(new URL(folder + 'preservation-report.json', root), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ roles: report.roles, totalAgents: defaults.agents.length }));
