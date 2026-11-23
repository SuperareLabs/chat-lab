const fixedVoiceIds = new Map([
  ['9a15fadb-1fa5-437d-aeee-6f2a3e1e8d65', 'S_eH42pcGL1'],
]);

export function normalizeVideoVoiceId(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || /^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) return trimmed;
  }
  throw Object.assign(new Error('音色 ID 最多 64 个字符，只能包含字母、数字、下划线或连字符'), { status: 400 });
}

export function videoVoiceIdForAgent(agent) {
  const value = agent?.metadata?.videoVoiceId;
  if (typeof value === 'string' && (!value || /^[a-zA-Z0-9_-]{1,64}$/.test(value))) return value;
  return fixedVoiceIds.get(agent?.id) || '';
}
