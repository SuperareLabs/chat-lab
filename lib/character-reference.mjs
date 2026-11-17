import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../character-packs/nuwa-20261116/source-manifest.json', import.meta.url), 'utf8'));
const roles = new Map([
  ['nuwa-feynman', 'feynman-perspective'], ['nuwa-munger', 'munger-perspective'],
  ['nuwa-steve-jobs', 'steve-jobs-perspective'], ['nuwa-zhang-yiming', 'zhang-yiming-perspective'],
  ['nuwa-sun-yuchen', 'sun-yuchen-perspective'],
]);

export function hasCharacterReferences(agentId) { return roles.has(agentId); }

const publicSources = new Map();
export function publicCharacterSource(agentId) {
  const slug = roles.get(agentId);
  if (!slug) return '';
  if (publicSources.has(agentId)) return publicSources.get(agentId);
  const item = manifest.files.find(file => file.sourcePath === `examples/${slug}/SKILL.md`);
  if (!item) return '';
  try {
    const buffer = readFileSync(resolve(root, item.path));
    if (buffer.length !== item.size || createHash('sha256').update(buffer).digest('hex') !== item.sha256) return '';
    const source = buffer.toString('utf8');
    publicSources.set(agentId, source);
    return source;
  } catch { return ''; }
}

export function readCharacterReference(agentId, { path, section, startLine, lineCount = 80 }) {
  const slug = roles.get(agentId);
  if (!slug) return { status: 'unavailable' };
  const files = manifest.files.filter(file => file.sourcePath.startsWith(`examples/${slug}/references/`));
  if (path === '__index__') return { status: 'found', commit: manifest.commit,
    paths: files.map(file => file.sourcePath.slice(`examples/${slug}/`.length)) };
  if (typeof path !== 'string' || !path.startsWith('references/') || path.includes('\\') ||
      path.split('/').some(part => !part || part === '.' || part === '..') ||
      (section !== undefined && (typeof section !== 'string' || !section.trim() || section.length > 120)) ||
      (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) ||
      !Number.isInteger(lineCount) || lineCount < 1 || lineCount > 120) return { status: 'invalid' };
  const item = files.find(file => file.sourcePath === `examples/${slug}/${path}`);
  if (!item) return { status: 'not_found', path };
  try {
    const filename = realpathSync(resolve(root, item.path));
    const allowedRoot = realpathSync(resolve(root, `character-packs/nuwa-20261116/upstream/${slug}/references`));
    if (relative(allowedRoot, filename).startsWith('..') || statSync(filename).size !== item.size) return { status: 'unavailable' };
    const buffer = readFileSync(filename);
    if (createHash('sha256').update(buffer).digest('hex') !== item.sha256) return { status: 'unavailable' };
    const lines = buffer.toString('utf8').split('\n');
    let begin = 0, end = lines.length;
    if (section !== undefined) {
      const headings = lines.map((line, index) => ({ line, index })).filter(x => /^## /.test(x.line));
      const matches = headings.filter(x => x.line.slice(3).trim().startsWith(section.trim()));
      if (!matches.length) return { status: 'not_found', path, section };
      if (matches.length !== 1) return { status: 'ambiguous', path, headings: matches.map(x => x.line.slice(3)) };
      begin = matches[0].index;
      end = headings.find(x => x.index > begin)?.index ?? lines.length;
    }
    begin = Math.max(begin, (startLine ?? begin + 1) - 1);
    if (begin >= end) return { status: 'not_found', path };
    const output = [];
    let cursor = begin, length = 0;
    while (cursor < end && output.length < lineCount) {
      if (length + lines[cursor].length + 1 > 12000) break;
      output.push(lines[cursor]); length += lines[cursor].length + 1; cursor++;
    }
    if (!output.length) return { status: 'unavailable', path };
    return { status: 'found', path, section: section ?? null, untrusted: true,
      sourceUrl: `https://github.com/alchaincyf/nuwa-skill/blob/${manifest.commit}/${item.sourcePath}`,
      commit: manifest.commit, sha256: item.sha256, startLine: begin + 1, endLine: cursor,
      totalLines: lines.length, truncated: cursor < end, nextStartLine: cursor < end ? cursor + 1 : null,
      content: output.join('\n') };
  } catch { return { status: 'unavailable', path }; }
}
