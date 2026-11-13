// Test-only neutral verifier for lifecycle tests whose subject is storage,
// scopes or fees. Semantic revise/drop behavior has dedicated review tests.
export function keepMemoryReview(options) {
  if (options.responseFormat?.json_schema?.name !== 'general_chat_memory_review_v1') return null;
  const { items } = JSON.parse(options.messages[1].content);
  return { content: JSON.stringify({ reviews: items.map(({ channel, index }) => ({ channel, index, decision: 'keep' })) }),
    toolCalls: [], receipt: { finish_reason: 'stop' } };
}
