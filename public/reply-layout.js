// Message boundaries are explicit. Newlines and blank lines stay in the text.
// Older messages without parts are displayed as one message, never re-guessed.
export function replyMessages(text, parts) {
  if (Array.isArray(parts) && parts.length && parts.every(part => typeof part === 'string' && part.trim())) return parts;
  return typeof text === 'string' && text.trim() ? [text] : [];
}
