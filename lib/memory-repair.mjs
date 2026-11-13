export const MEMORY_REPAIR_PROMPT = `上一次记忆整理没有通过后端校验。请根据原始会话、已有记忆和下面的具体错误，重新完成一次提取。

沿用原任务、原用户消息编号、原记忆 ID 和输出协议，返回完整 JSON，包含 creates、updates、mentions、retractions、overview，不只返回出错条目或补丁。
根据原始资料完整判断有依据的新增、补充、更正、提及、撤回及概括来源，保留值得记住的新信息和实质变化。
同一记忆 ID 最终只对应一种操作。有实质更新时输出 updates，单纯重复提及时输出 mentions；按原消息选择真正支持该操作的用户来源。
只引用原输入中的有效编号，事实和日期以原始证据为准。只返回完整 JSON。`;

/** Re-extract from the exact original request plus error feedback only. The
 * failed JSON remains in the local audit and is not sent back to the model. */
export function memoryRepairRequestFor({ request, error }) {
  if (!request || !Array.isArray(request.messages)) {
    throw new Error('记忆修正需要原始提取请求');
  }
  const validationContext = error?.validationContext ? { ...error.validationContext } : null;
  if (validationContext && Object.hasOwn(validationContext, 'anchorMessageId')) {
    const ref = request.references?.find(item => item.messageId === validationContext.anchorMessageId)?.ref;
    delete validationContext.anchorMessageId;
    if (ref) validationContext.anchorUserRef = ref;
  }
  const diagnosis = {
    validationError: typeof error?.message === 'string' ? error.message : String(error),
    validationContext,
  };
  return {
    messages: [...request.messages,
      { role: 'user', content: MEMORY_REPAIR_PROMPT + '\n\n' + JSON.stringify(diagnosis) }],
    responseFormat: request.responseFormat,
  };
}
