// Ark Chat API: one request per invocation, no automatic paid retries.
const DEFAULT_MODEL = 'doubao-seed-2-1-lite-260915';
const DEFAULT_ENDPOINT = 'ep-m-20261008164832-9996q';
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const MAX_STREAM_BYTES = 4 * 1024 * 1024;

function redact(value, key) {
  let text = String(value ?? '未知供应商错误');
  if (key) text = text.split(key).join('[credential redacted]');
  return text
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token)\s*[=:]\s*)[^\s&,"']+/gi, '$1[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 300);
}

export class ProviderError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR', status = null, outcomeUnknown = false, aborted = false, receipt = null } = {}) {
    super(message);
    this.name = aborted ? 'AbortError' : 'ProviderError';
    this.code = code;
    this.status = status;
    this.outcome_unknown = outcomeUnknown;
    this.receipt = receipt;
  }
}

function errorPayload(value) {
  return value?.error?.message ?? value?.message ?? '供应商拒绝了请求';
}

function extractContent(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('');
  throw new ProviderError('供应商返回了不支持的文本格式', { code: 'INVALID_RESPONSE', outcomeUnknown: true });
}

/** The exact JSON request is delivered to onRequest without headers or credentials. */
export function createProvider({ apiKey = '', endpoint = DEFAULT_ENDPOINT, model = DEFAULT_MODEL, baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = 90_000, ark = true } = {}) {
  const key = String(apiKey).trim();
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid provider timeout');

  return {
    async chat({ messages, tools, responseFormat, signal, onDelta, onRequest, maxTokens = 1536, thinking = 'disabled', reasoningEffort } = {}) {
      if (!key) throw new ProviderError('请先配置后端 ARK_API_KEY', { code: 'NOT_CONFIGURED' });
      if (!Array.isArray(messages) || !messages.length) throw new ProviderError('模型消息列表不能为空', { code: 'INVALID_REQUEST' });
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16384) throw new ProviderError('maxTokens 超出实验室范围', { code: 'INVALID_REQUEST' });
      if (!['enabled', 'disabled'].includes(thinking)) throw new ProviderError('thinking 参数无效', { code: 'INVALID_REQUEST' });
      if (reasoningEffort !== undefined && !['low', 'high', 'max'].includes(reasoningEffort)) throw new ProviderError('reasoningEffort 参数无效', { code: 'INVALID_REQUEST' });
      const stream = !responseFormat;
      const body = {
        model: endpoint || model,
        messages: structuredClone(messages),
        stream,
        ...(ark ? { thinking: { type: thinking } } : {}),
        ...(ark && thinking === 'enabled' && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        max_tokens: maxTokens,
        ...(stream ? { stream_options: { include_usage: true } } : { response_format: structuredClone(responseFormat) }),
        ...(Array.isArray(tools) && tools.length ? { tools: structuredClone(tools), tool_choice: 'auto' } : {}),
      };
      const serializedBody = JSON.stringify(body);
      const controller = new AbortController();
      const started = performance.now();
      let firstText = null;
      let dispatched = false;
      let timedOut = false;
      let reader;
      const receipt = { model: null, usage: null, finish_reason: null, provider_id: null, service_tier: null };
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      timer.unref?.();
      const metrics = () => ({ first_text_ms: firstText == null ? null : Math.round(firstText), total_ms: Math.round(performance.now() - started) });
      // Usage can arrive before a stream fails. Keep its accounting receipt,
      // never response text, tool arguments, or hidden reasoning in an error.
      const failureReceipt = () => receipt.usage == null ? null : structuredClone(receipt);
      const fail = (message, options = {}) => new ProviderError(redact(message, key), { ...options, receipt: failureReceipt() });
      const aborted = () => fail(timedOut ? '模型请求超时；未自动重试' : '模型请求已停止', {
        code: timedOut ? 'TIMEOUT' : 'ABORTED', outcomeUnknown: dispatched, aborted: !timedOut,
      });
      try {
        if (controller.signal.aborted) throw aborted();
        await onRequest?.(JSON.parse(serializedBody));
        if (controller.signal.aborted) throw aborted();
        dispatched = true;
        const response = await fetchImpl(url, {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: serializedBody, signal: controller.signal,
        });
        if (!response.ok) {
          // Raw body may contain request data or a credential; only a bounded, redacted message leaves this module.
          const raw = await response.text();
          let payload;
          try { payload = JSON.parse(raw); } catch { payload = null; }
          throw fail(`模型请求失败（HTTP ${response.status}）：${payload ? errorPayload(payload) : '供应商未返回可解析的错误说明'}`, {
            code: 'HTTP_ERROR', status: response.status, outcomeUnknown: false,
          });
        }
        if (!stream) {
          let result;
          try { result = await response.json(); } catch { throw fail('供应商返回了无效 JSON', { code: 'INVALID_RESPONSE', outcomeUnknown: true }); }
          if (result?.model != null) receipt.model = result.model;
          if (result?.id != null) receipt.provider_id = result.id;
          if (result?.usage != null) receipt.usage = result.usage;
          receipt.service_tier = typeof result?.service_tier === 'string' ? result.service_tier : null;
          const choice = result?.choices?.[0];
          if (choice?.finish_reason != null) receipt.finish_reason = choice.finish_reason;
          if (result.error) throw fail(errorPayload(result), { code: 'PROVIDER_ERROR', outcomeUnknown: true });
          if (!choice?.message || !choice.finish_reason) throw fail('供应商返回缺少消息或完成标记', { code: 'INVALID_RESPONSE', outcomeUnknown: true });
          const content = extractContent(choice.message.content);
          if (content) firstText = performance.now() - started;
          return {
            content,
            toolCalls: (choice.message.tool_calls ?? []).map(call => ({ id: call.id, type: 'function', function: { name: call.function?.name, arguments: call.function?.arguments ?? '' } })),
            receipt,
            metrics: metrics(),
          };
        }
        if (!response.body) throw fail('供应商流响应没有内容', { code: 'INVALID_RESPONSE', outcomeUnknown: true });
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let dataLines = [];
        let bytesRead = 0;
        let content = '';
        let doneMarker = false;
        const calls = new Map();
        const dispatch = async () => {
          if (!dataLines.length) return;
          const raw = dataLines.join('\n');
          dataLines = [];
          if (raw === '[DONE]') { doneMarker = true; return; }
          let chunk;
          try { chunk = JSON.parse(raw); } catch { throw fail('模型 SSE 数据无法解析', { code: 'INVALID_STREAM', outcomeUnknown: true }); }
          if (chunk.model != null) receipt.model = chunk.model;
          if (chunk.id != null) receipt.provider_id = chunk.id;
          if (chunk.usage != null) receipt.usage = chunk.usage;
          if ('service_tier' in chunk) receipt.service_tier = typeof chunk.service_tier === 'string' ? chunk.service_tier : null;
          if (chunk.error) throw fail(errorPayload(chunk), { code: 'PROVIDER_ERROR', outcomeUnknown: true });
          const choice = chunk.choices?.find(x => x.index === 0) ?? chunk.choices?.[0];
          if (!choice) return;
          if (choice.finish_reason != null) receipt.finish_reason = choice.finish_reason;
          const delta = choice.delta ?? {};
          // Deliberately ignore reasoning_content: the UI shows actions and inputs, never hidden reasoning.
          const fragment = extractContent(delta.content);
          if (fragment) {
            if (firstText == null) firstText = performance.now() - started;
            content += fragment;
            await onDelta?.(fragment);
          }
          for (const part of delta.tool_calls ?? []) {
            if (!Number.isInteger(part.index) || part.index < 0 || part.index > 31) throw fail('工具调用索引超出范围', { code: 'INVALID_STREAM', outcomeUnknown: true });
            const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (part.id) call.id = part.id;
            if (part.type && part.type !== 'function') throw fail('供应商返回未知工具类型', { code: 'INVALID_STREAM', outcomeUnknown: true });
            if (part.function?.name) call.function.name += part.function.name;
            if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments;
            calls.set(part.index, call);
          }
        };
        const line = async value => {
          if (value.endsWith('\r')) value = value.slice(0, -1);
          if (value === '') return dispatch();
          if (value.startsWith('data:')) dataLines.push(value.slice(5).replace(/^ /, ''));
        };
        while (!doneMarker) {
          if (controller.signal.aborted) throw aborted();
          const { value, done } = await reader.read();
          if (done) break;
          bytesRead += value.byteLength;
          if (bytesRead > MAX_STREAM_BYTES) throw fail('模型响应超过实验室大小上限', { code: 'RESPONSE_LIMIT', outcomeUnknown: true });
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n')) !== -1) {
            await line(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            if (doneMarker) break;
          }
        }
        buffer += decoder.decode();
        if (!doneMarker && buffer) await line(buffer);
        if (!doneMarker) await dispatch();
        if (controller.signal.aborted) throw aborted();
        // A disconnected partial response must never be treated as a completed message.
        if (!receipt.finish_reason) throw fail('模型流提前结束，未收到完成标记', { code: 'TRUNCATED_STREAM', outcomeUnknown: true });
        const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
        if (toolCalls.some(call => !call.id || !call.function.name)) throw fail('模型工具调用不完整', { code: 'INVALID_STREAM', outcomeUnknown: true });
        return { content, toolCalls, receipt, metrics: metrics() };
      } catch (error) {
        if (controller.signal.aborted) throw aborted();
        if (error instanceof ProviderError) {
          error.message = redact(error.message, key);
          error.receipt = failureReceipt();
          throw error;
        }
        throw fail(error?.message ?? '模型连接失败', { code: 'NETWORK_ERROR', outcomeUnknown: dispatched });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (reader) { try { await reader.cancel(); } catch {} }
      }
    },
  };
}
