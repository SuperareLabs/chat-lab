import { readFileSync } from 'node:fs';

/** Trusted server configuration; never taken from a browser role or metadata. */
export function loadSharedPrompts(file = new URL('../config/shared-prompts.json', import.meta.url)) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (config.schemaVersion !== 1 || !Array.isArray(config.prompts)) throw new Error('共享提示词配置无效');
  const ids = new Set();
  return config.prompts.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) ||
        typeof item.title !== 'string' || !item.title.trim() ||
        !Array.isArray(item.agentIds) || !item.agentIds.length ||
        item.agentIds.some(id => typeof id !== 'string' || !id.trim()) ||
        typeof item.file !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.md$/.test(item.file)) {
      throw new Error('共享提示词须有唯一编号、标题、明确角色范围和配置目录内的 Markdown 文件');
    }
    ids.add(item.id);
    const content = readFileSync(new URL(item.file, file), 'utf8');
    if (!content.trim() || content.includes('\0') || Buffer.byteLength(content) > 56_000) throw new Error('共享提示词内容无效或超限');
    return { id: item.id, title: item.title, agentIds: [...item.agentIds], content };
  });
}

export function renderSharedPrompts(prompts, agentId) {
  const selected = prompts.filter(item => item.agentIds.includes(agentId));
  if (!selected.length) return '';
  return '以下为共同背景。当前角色的专长、日常字数条数和接话方式，以后面的角色设定为准；实际可执行能力以本轮提供的工具为准。\n\n' +
    selected.map(item => `【${item.title}】\n${item.content}`).join('\n\n');
}
