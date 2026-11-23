import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { availableTools, characterMediaTools, makeToolRunner } from './tools.mjs';
import { memoryRequestFor, resolveMemoryOutput, validateMemoryOutput } from './memory.mjs';
import { memoryRepairRequestFor, MEMORY_REPAIR_PROMPT } from './memory-repair.mjs';
import { briefRequestFor, validateBriefOutput, CONTEXT_BRIEF_VERSION, CONTEXT_BRIEF_PROMPT } from './context-brief.mjs';
import { COMMON_PROMPT, loadSouls, MEMORY_PROMPT, prepareMessages, renderSoul, agentSeedForSoul, soulFromAgent, agentView,
  SOUL_RENDER_CONTRACT_VERSION, toLocalTime } from './prompts.mjs';
import { compileOutputBoundary } from './output-boundary.mjs';
import { CHAT_OUTPUT_PROMPT, CHAT_RESPONSE_FORMAT, decodeChatOutput, chatHistoryForModel, ReplyFormatError } from './chat-output.mjs';
import { publicCharacterSource } from './character-reference.mjs';
import { problem } from './store.mjs';
import { MEMORY_FRAMEWORK_VERSION, MEMORY_COMPATIBLE_DATA_VERSIONS } from './memory-version.mjs';
import { estimateUsage, getModelContext } from './usage-cost.mjs';

export const SESSION_IDLE_MS = 15 * 60 * 1000;

const TOOL_PRESENTATIONS = {
  search_web: { acknowledgement: '我查查。', label: '正在查找…' },
  calculate: { acknowledgement: '我算一下。', label: '正在计算…' },
  send_character_photo: { acknowledgement: '我发张照片给你。', label: '正在生成角色照片…' },
  send_character_video: { acknowledgement: '我发段小视频给你。', label: '正在生成角色短片…' },
  read_character_reference: { acknowledgement: '我看看这段资料。', label: '正在查看人物资料…' },
  recall_memory: { acknowledgement: '我想想咱们之前聊过的。', label: '正在回想…' },
  get_memory_detail: { acknowledgement: '我想想咱们之前聊过的。', label: '正在回想…' },
};

function toolPresentation(calls, modelText) {
  const presentation = TOOL_PRESENTATIONS[calls[0]?.function?.name] ?? { acknowledgement: '我看看。', label: '正在处理…' };
  const firstLine = modelText.trim().split(/\r?\n/)[0] ?? '';
  const firstSentence = firstLine.match(/^.*?[。！？!?]/u)?.[0] ?? firstLine;
  return {
    ...presentation,
    acknowledgement: firstSentence && [...firstSentence].length <= 40 ? firstSentence : presentation.acknowledgement,
  };
}

function previousWebSearch(rawContext) {
  let saved;
  try { saved = JSON.parse(rawContext ?? 'null'); } catch { return null; }
  const result = saved?.previousWebSearch ?? (Array.isArray(saved?.toolCalls)
    ? saved.toolCalls.findLast(call => call.name === 'search_web' && call.result?.ok === true)?.result : null);
  return result?.ok === true && Array.isArray(result.results) && result.results.length
    ? { ...result, untrusted: true } : null;
}

export class ChatRuntime {
  constructor({ store, provider, model, memoryProvider = provider, memoryModel = model, search, appVersion, timezone = 'Asia/Shanghai', clock = () => new Date(),
    idleMs = SESSION_IDLE_MS, souls, memoryFrameworkVersion = MEMORY_FRAMEWORK_VERSION,
    contextBriefEnabled = false, allowDataReset = true, sharedPrompts = [], recentEventsEnabled = false, characterMedia }) {
    this.store = store;
    this.provider = provider;
    this.memoryProvider = memoryProvider;
    this.memoryModel = memoryModel;
    this.search = search;
    this.characterMedia = characterMedia;
    this.model = model;
    this.timezone = timezone;
    this.clock = clock;
    this.idleMs = idleMs;
    this.initialSouls = souls;
    this.sharedPrompts = sharedPrompts;
    this.souls = new Map();
    this.appVersion = appVersion;
    this.memoryFrameworkVersion = memoryFrameworkVersion;
    this.contextBriefEnabled = contextBriefEnabled;
    this.recentEventsEnabled = recentEventsEnabled;
    this.allowDataReset = allowDataReset;
    this.systems = new Map();
    this.dataVersion = createHash('sha256').update(JSON.stringify([
      memoryFrameworkVersion, MEMORY_PROMPT, MEMORY_REPAIR_PROMPT, COMMON_PROMPT, SOUL_RENDER_CONTRACT_VERSION,
    ])).digest('hex');
    this.compatibleDataVersions = [...(MEMORY_COMPATIBLE_DATA_VERSIONS[memoryFrameworkVersion] ?? [])];
    // Historical framework-1 fixtures retain their narrowly scoped 1.0.8
    // adoption path. Production framework 6 uses only the explicit allowlist.
    if (memoryFrameworkVersion === 1 && souls) {
      const systems = [...souls].map(([id, soul]) => [id, renderSoul(soul)]).sort(([a], [b]) => a.localeCompare(b));
      this.compatibleDataVersions.push(createHash('sha256').update(JSON.stringify([
        '1.0.8', MEMORY_PROMPT, systems.map(([id, prompt]) => [id, souls.get(id).version, prompt]),
      ])).digest('hex'));
    }
    this.timer = null;
    this.worker = null;
    this.chatRuns = new Set();
    this.backgroundController = null;
    this.briefWorker = null;
    this.briefController = null;
    this.stopped = false;
  }

  initialize() {
    const needsAgents = !this.store.agentsInitialized();
    const importSeeds = needsAgents && (this.initialSouls !== undefined || this.store.hasLegacyAgentData());
    this.store.activateVersion(this.dataVersion, this.now(), { compatibleVersions: this.compatibleDataVersions,
      allowReset: this.allowDataReset });
    if (needsAgents) {
      const seeds = importSeeds ? this.initialSouls ?? loadSouls() : new Map();
      this.store.initializeAgents([...seeds.values()].map(agentSeedForSoul), this.now(), { importSeeds });
    }
    this.refreshAgents();
    this.store.recover(this.now());
    if (this.contextBriefEnabled) for (const child of this.store.children()) {
      for (const agentId of this.souls.keys()) this.store.ensureContextBrief(child.id, agentId, this.now(), { modelName: this.memoryModel.name });
    }
  }

  now() { return this.clock().toISOString(); }

  refreshAgents() {
    this.agentRecords = new Map(this.store.agentRecords().map(record => [record.id, record]));
    this.souls = new Map([...this.agentRecords].map(([id, record]) => [id, soulFromAgent(record)]));
    this.systems = new Map([...this.souls].map(([id, soul]) => [id, renderSoul(soul, { sharedPrompts: this.sharedPrompts })]));
  }

  agent(id) {
    this.refreshAgents();
    const record = this.agentRecords.get(this.agentId(id));
    if (!record) throw problem('找不到此角色', 404);
    return agentView(record);
  }

  createAgent(input) {
    const saved = this.store.createAgent(input, this.now());
    this.refreshAgents();
    return agentView(saved);
  }

  updateAgent(id, input) {
    const saved = this.store.updateAgent(this.agentId(id), input, this.now());
    this.refreshAgents();
    return agentView(saved);
  }

  accountUsage({ key, sessionId, runId = null, kind, name = null, receipt = null, model = this.model.name,
    pending = false, status = 'succeeded', metrics = null, index, id, local = false }) {
    const actualModel = receipt?.model || model || null;
    const entry = estimateUsage({
      model: actualModel, usage: receipt?.usage ?? null, serviceTier: receipt?.service_tier ?? null,
      at: this.now(), kind, searchCalls: receipt?.search_calls,
    });
    const context = kind === 'chat' ? getModelContext(actualModel) : null;
    return this.store.recordUsage({
      key, sessionId, runId, kind, name, ...entry, model: actualModel,
      pending, status: pending ? 'running' : status, local, index, id,
      providerId: receipt?.provider_id ?? null, serviceTier: receipt?.service_tier ?? null,
      finishReason: receipt?.finish_reason ?? receipt?.status ?? null,
      rawUsage: receipt?.usage ?? null, metrics,
      ...(kind === 'chat' ? { contextWindowTokens: context?.contextWindowTokens ?? null, outputReserveTokens: 1400 } : {}),
    }, this.now());
  }

  emitUsage(emit, sessionId) {
    emit({ type: 'usage', sessionId, usage: this.store.usage(sessionId) });
  }

  agentId(id) {
    return id === 'croco-lab' && this.souls.has('9a15fadb-1fa5-437d-aeee-6f2a3e1e8d65')
      ? '9a15fadb-1fa5-437d-aeee-6f2a3e1e8d65' : id;
  }

  state() {
    this.refreshAgents();
    return {
      agents: [...this.agentRecords.values()].filter(record => record.metadata?.hidden !== true).map(agentView),
      children: this.store.children(),
      model: this.model,
      memoryModel: this.memoryModel,
      appVersion: this.appVersion,
      memoryFrameworkVersion: this.memoryFrameworkVersion,
      contextBriefVersion: this.contextBriefEnabled ? CONTEXT_BRIEF_VERSION : null,
      dataResetAllowed: this.allowDataReset,
      dataVersion: this.dataVersion,
    };
  }

  promptDetail(id) {
    this.refreshAgents();
    const agentId = this.agentId(id);
    const soul = this.souls.get(agentId);
    const system = this.systems.get(agentId);
    if (!soul || typeof system !== 'string') throw problem('找不到此角色', 404);
    const sharedPrompts = this.sharedPrompts.filter(item => item.agentIds.includes(agentId));
    return {
      agentId, name: soul.identity.name, version: soul.version,
      definition: this.agentRecords.get(agentId).definition, revision: this.agentRecords.get(agentId).revision,
      model: this.model.name, dataVersion: this.dataVersion,
      system, common: COMMON_PROMPT, role: system.slice(COMMON_PROMPT.length + 2),
      replyProtocol: CHAT_OUTPUT_PROMPT,
      ...(sharedPrompts.length ? { sharedPrompts } : {}),
      memory: MEMORY_PROMPT,
      memoryReview: '',
      memoryRepair: MEMORY_REPAIR_PROMPT,
      contextBrief: this.contextBriefEnabled ? CONTEXT_BRIEF_PROMPT : '',
      memoryModel: this.memoryModel.name,
    };
  }

  assertScope(childId, agentId) {
    this.refreshAgents();
    if (typeof childId !== 'string' || typeof agentId !== 'string' || !childId || !agentId) {
      throw problem('请先选择用户和角色');
    }
    if (!this.souls.has(agentId) || !this.store.child(childId)) throw problem('找不到此用户或角色', 404);
  }

  assertAudience(childId, agentId) {
    if (this.agentRecords.get(agentId)?.metadata?.hidden === true) {
      throw problem('此角色已删除或下架，不能继续发起聊天', 410);
    }
    const minimumAge = this.souls.get(agentId)?.audience?.minimumAge;
    if (!minimumAge) return;
    const age = this.store.child(childId)?.age;
    if (!Number.isInteger(age) || age < minimumAge) {
      throw problem(`此角色仅面向${minimumAge}岁及以上用户，请选择已填写成年年龄的用户`, 403);
    }
  }

  tick() {
    if (this.stopped) return;
    this.store.closeDue(this.now(), this.idleMs);
    clearTimeout(this.timer);
    const deadline = this.store.nextDeadline(this.idleMs);
    if (deadline != null) {
      this.timer = setTimeout(() => this.tick(), Math.max(1, Math.min(deadline - this.clock().getTime(), 2_147_483_647)));
      this.timer.unref();
    }
    this.startWorker();
    this.startBriefWorker();
  }

  chatOverview(childId, agentId, { includeSources = false } = {}) {
    const view = this.contextBriefEnabled
      ? this.store.readContextBrief(childId, agentId, { modelName: this.memoryModel.name })
      : this.store.userOverview(childId, agentId);
    return this.contextBriefEnabled && includeSources ? { ...view,
      sourceRecords: this.store.readBriefSources(childId, agentId, { modelName: this.memoryModel.name }).records } : view;
  }

  queueContextBrief(childId, agentId, sessionId) {
    if (!this.contextBriefEnabled) return this.store.userOverview(childId, agentId);
    const view = this.store.ensureContextBrief(childId, agentId, this.now(), { modelName: this.memoryModel.name, sessionId });
    this.startBriefWorker();
    return view;
  }

  startBriefWorker() {
    if (!this.contextBriefEnabled || this.briefWorker || this.stopped || !this.memoryModel.configured) return;
    const job = this.store.claimContextBrief(this.now(), { modelName: this.memoryModel.name });
    if (!job) return;
    this.briefController = new AbortController();
    this.briefWorker = this.generateContextBrief(job, this.briefController.signal).finally(() => {
      this.briefWorker = null;
      this.briefController = null;
      if (!this.stopped) this.startBriefWorker();
    });
  }

  async generateContextBrief(job, signal) {
    const key = `context-brief:${job.child_id}:${job.agent_id}:${job.fingerprint}`;
    let received = false;
    let started = false;
    try {
      const request = briefRequestFor(job.records);
      if (!request) throw new Error('没有可整理的长期了解来源');
      this.accountUsage({ key, sessionId: job.session_id, kind: 'context_brief', name: 'context_brief', model: job.model_name, pending: true });
      started = true;
      const response = await this.memoryProvider.chat({ ...request, signal, maxTokens: 8192 });
      this.accountUsage({ key, sessionId: job.session_id, kind: 'context_brief', name: 'context_brief', model: job.model_name,
        receipt: response.receipt, metrics: response.metrics });
      received = true;
      this.store.recordContextBriefOutput(job, response);
      if (signal.aborted) throw new Error('服务已停止，概括投影没有提交');
      if (response.receipt?.finish_reason === 'length') throw new Error('概括选源输出达到长度上限');
      const selection = validateBriefOutput(response.content, job.records);
      this.store.commitContextBrief(job, selection, this.now(), { modelName: this.memoryModel.name });
    } catch (error) {
      if (started && !received) this.accountUsage({ key, sessionId: job.session_id, kind: 'context_brief', name: 'context_brief',
        model: job.model_name, receipt: error.receipt, status: 'failed' });
      this.store.failContextBrief(job, this.publicError(error, '概括投影整理失败'), this.now());
    }
  }

  startWorker() {
    if (this.worker || this.stopped || !this.memoryModel.configured) return;
    const job = this.store.claimJob(this.now());
    if (!job) return;
    this.backgroundController = new AbortController();
    this.worker = this.extract(job, this.backgroundController.signal).finally(() => {
      this.worker = null;
      this.backgroundController = null;
      if (!this.stopped) this.startWorker();
    });
  }

  async extract(job, signal) {
    const key = `memory:${job.session_id}:${randomUUID()}`;
    let stage = 'extraction';
    let started = false;
    let received = false;
    const assertNotAborted = () => {
      if (signal.aborted) throw new Error('服务已停止，本次整理没有提交');
    };
    const call = async (request, nextStage) => {
      assertNotAborted();
      stage = nextStage;
      started = false;
      received = false;
      this.accountUsage({ key: `${key}:${stage}`, sessionId: job.session_id, kind: 'memory', name: stage,
        model: this.memoryModel.name, pending: true });
      started = true;
      const response = await this.memoryProvider.chat({ messages: request.messages,
        responseFormat: request.responseFormat, signal, maxTokens: 8192 });
      received = true;
      this.accountUsage({ key: `${key}:${stage}`, sessionId: job.session_id, kind: 'memory', name: stage,
        model: this.memoryModel.name, receipt: response.receipt, metrics: response.metrics });
      this.store.recordMemoryOutput(job, { content: response.content, receipt: response.receipt,
        metrics: response.metrics }, { stage });
      assertNotAborted();
      // A truncated response is not a complete candidate to repair. Preserve
      // its raw output and receipt without starting another charged request.
      if (response.receipt?.finish_reason === 'length') throw new Error(stage === 'repair'
        ? '已修正1次仍失败：模型的修正输出达到长度上限'
        : '模型的整理输出达到长度上限，本次未自动修正');
      return response;
    };
    try {
      assertNotAborted();
      if (!job.snapshot.some(message => message.role === 'user')) throw new Error('此会话没有可整理的用户消息');
      const input = this.store.memoryInput(job.child_id, job.agent_id, job.snapshot);
      const request = memoryRequestFor(job.snapshot, this.timezone, input);
      this.store.recordMemoryInput?.(job, { ...input, messageReferences: request.references });
      const validate = content => validateMemoryOutput(
        resolveMemoryOutput(content, job.snapshot, { allowRealUserIds: false }), job.snapshot, this.timezone, input);
      const response = await call(request, 'extraction');
      let plan;
      try {
        plan = validate(response.content);
      } catch (error) {
        if (!this.store.recordMemoryValidationFailure(job, { stage: 'extraction', error }, this.now())) {
          throw new Error('记忆任务已结束，本次没有继续修正');
        }
        assertNotAborted();
        if (this.store.memoryRevision(job.child_id, job.agent_id) !== input.revision) {
          throw Object.assign(new Error('记忆库已变化，本次未继续付费修正，也未覆盖新记忆'), { code: 'MEMORY_REVISION_CONFLICT' });
        }
        const repaired = await call(memoryRepairRequestFor({ request, error }), 'repair');
        try {
          plan = validate(repaired.content);
        } catch (repairError) {
          this.store.recordMemoryValidationFailure(job, { stage: 'repair', error: repairError }, this.now());
          throw Object.assign(new Error('已修正1次仍失败：' + this.publicError(repairError, '记忆校验失败')),
            { validationContext: repairError.validationContext });
        }
      }
      this.store.commitJob(job, plan, this.now(), { timezone: this.timezone, revision: input.revision });
      this.queueContextBrief(job.child_id, job.agent_id, job.session_id);
    } catch (error) {
      if (started && !received) this.accountUsage({
        key: `${key}:${stage}`, sessionId: job.session_id, kind: 'memory', name: stage,
        model: this.memoryModel.name, receipt: error.receipt, status: 'failed',
      });
      this.store.failJob(job, this.publicError(error, '记忆整理失败'), this.now(), { validationContext: error.validationContext });
    }
  }

  beginChat(args) {
    if (!this.model.configured) throw problem('当前没有配置模型。请在本机后端配置 ARK_API_KEY 或外部凭据文件后重启。', 503);
    const agentId = this.agentId(args.agentId);
    this.assertScope(args.childId, agentId);
    this.assertAudience(args.childId, agentId);
    const run = this.store.beginChat({ ...args, agentId }, this.now(), this.idleMs);
    if (!run.replay) run.system = this.systems.get(agentId);
    this.tick();
    return run;
  }

  async chat(run, emit, signal) {
    if (run.replay) {
      emit({ type: 'start', sessionId: run.sessionId });
      if (run.parts?.length) {
        for (const [index, text] of run.parts.entries()) {
          emit({ type: 'delta', text: (index ? '\n\n' : '') + text });
          emit({ type: 'reply_part', index, text, kind: !index && run.toolAcknowledged ? 'acknowledgement' : 'answer' });
        }
      } else if (run.reply) emit({ type: 'delta', text: run.reply });
      if (run.attachment) emit({ type: 'character_media', attachment: run.attachment });
      this.emitUsage(emit, run.sessionId);
      if (run.status === 'succeeded') emit({ type: 'done', sessionId: run.sessionId });
      else emit({ type: 'error', message: run.error || '上一轮没有完成' });
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, { once: true });
    const running = this.generate(run, emit, controller.signal);
    const current = { running, controller };
    this.chatRuns.add(current);
    try {
      await running;
    } finally {
      this.chatRuns.delete(current);
      signal.removeEventListener('abort', abort);
    }
  }

  async generate(run, emit, signal) {
    emit({ type: 'start', sessionId: run.sessionId });
    const started = performance.now();
    let reply = '';
    const parts = [];
    let acknowledged = false;
    let answered = false;
    let formatRepairUsed = false;
    let repairingFormat = false;
    let context;
    let attachment;
    try {
      const { childProfile: child } = this.store.profile(run.childId, run.agentId);
      const { id, ...userProfile } = child;
      run.sharedProfile = { ...userProfile };
      const userOverview = this.queueContextBrief(run.childId, run.agentId, run.sessionId);
      const localTime = toLocalTime(this.clock(), this.timezone);
      const history = this.store.messages(run.sessionId);
      const agent = this.characterMedia ? this.store.agentRecord(run.agentId) : null;
      const tools = availableTools(this.search, run.agentId, this.characterMedia, agent);
      const system = run.system ?? this.systems.get(run.agentId);
      // Upstream public quotes can be spoken; the common policy, adapter and
      // any private edits remain covered by the existing exact-copy backstop.
      const publicSource = publicCharacterSource(run.agentId);
      const privateSystem = publicSource && system.includes(publicSource) ? system.replace(publicSource, '') : system;
      const boundaryForRun = compileOutputBoundary([privateSystem, CHAT_OUTPUT_PROMPT]);
      const priorSearch = previousWebSearch(this.store.rawSession(run.sessionId, run.childId, run.agentId)?.context);
      const recentEvents = this.recentEventsEnabled
        ? this.store.recentEventSummaries(run.childId, run.agentId, localTime.utcIso)
        : undefined;
      const recentRule = recentEvents?.length
        ? '\n\n【最近聊过的事】先接对方这轮说的话。只有对方正在聊同一件事，或这句话需要旧事才能理解时，才用相关摘要补上必要细节。关联不清楚时，只接眼前的话，把下一个话题留给对方。不要从这些摘要里挑旧事来开话题。'
        : '';
      const hasCharacterMedia = tools.some(({ function: { name } }) => Object.hasOwn(characterMediaTools, name));
      const mediaRule = hasCharacterMedia
        ? '\n\n【角色影像】这两项工具只用来分享你自己在当前情景里的样子和生活片段。对方明确要看自拍或短视频时可以调用；单问你在做什么时，通常自然回复，影像更贴合情境时才发。优先照片；明确要视频或关键在动作时才发短片。一次只发一种。只描述可见的虚构地点、物件、姿势和动作，勿传用户资料、私人经历、URL 或原始聊天。拒绝无关的代出图、代剪片等请求。工具失败就如实说暂时发不了。素材是生成的，别把它当现实拍摄的凭据。'
        : '';
      const requestSystem = `${system}\n\n${CHAT_OUTPUT_PROMPT}${recentRule}${mediaRule}`;
      const messages = prepareMessages({ system: requestSystem, localTime, userProfile, userOverview, recentEvents,
        previousWebSearch: priorSearch, history: chatHistoryForModel(history) });
      context = {
        model: this.model.name, system: requestSystem, localTime, userProfile, userOverview,
        ...(recentEvents ? { recentEvents } : {}),
        ...(priorSearch ? { previousWebSearch: priorSearch } : {}),
        history, tools, requestMessages: messages, toolCalls: [], preparedAt: this.now(),
        modelRequests: [], firstDeltaMs: null,
      };
      const runner = makeToolRunner({ store: this.store, search: this.search, media: this.characterMedia, agent, run, clock: this.clock, signal });
      const sent = new Set();
      const publishPart = (text, kind) => {
        if (!text.trim() || signal.aborted) return;
        if (context.firstDeltaMs == null) context.firstDeltaMs = Math.round(performance.now() - started);
        const index = parts.length;
        parts.push(text);
        reply = parts.join('\n\n');
        emit({ type: 'delta', text: (index ? '\n\n' : '') + text });
        emit({ type: 'reply_part', index, text, kind });
      };
      for (let round = 0; round < 5; round++) {
        if (signal.aborted) throw new Error('这轮聊天已停止');
        let streamed = '';
        const modelRequest = { round: round + 1, inputChars: JSON.stringify({ messages, tools }).length,
          ...(repairingFormat ? { purpose: 'reply-format-repair' } : {}),
          thinking: this.model.thinking ?? 'disabled', reasoningEffort: this.model.reasoningEffort ?? null };
        context.modelRequests.push(modelRequest);
        this.store.recordContext(run.sessionId, context);
        const usageKey = `chat:${run.runId}:${round}`;
        const recordRequest = extra => {
          const usage = this.accountUsage({ key: usageKey, sessionId: run.sessionId, runId: run.runId, kind: 'chat', ...extra });
          modelRequest.usage = usage;
          this.emitUsage(emit, run.sessionId);
          return usage;
        };
        recordRequest({ pending: true });
        let response;
        try {
          response = await this.provider.chat({
            messages, tools: repairingFormat ? [] : tools, signal, responseFormat: CHAT_RESPONSE_FORMAT,
            maxTokens: this.model.thinking === 'enabled' ? 8192 : 1400,
            thinking: this.model.thinking ?? 'disabled', reasoningEffort: this.model.reasoningEffort,
            // Buffer until actual tool calls are known before publishing an acknowledgement.
            onDelta: delta => { streamed += delta; },
          });
        } catch (error) {
          modelRequest.error = {
            code: error.code === 'NETWORK_ERROR' ? 'NETWORK_ERROR' : 'MODEL_REQUEST_FAILED',
            ...(error.networkCode ? { networkCode: error.networkCode } : {}),
            outcomeUnknown: error.outcome_unknown === true,
          };
          recordRequest({ receipt: error.receipt, metrics: error.metrics, status: 'failed' });
          // Log transport diagnostics only, never prompts, user text or credentials.
          console.error(JSON.stringify({ event: 'chat-model-request-failed', ...modelRequest.error,
            round: round + 1, thinking: modelRequest.thinking, elapsedMs: error.metrics?.total_ms ?? null }));
          throw error;
        }
        recordRequest({ receipt: response.receipt, metrics: response.metrics });
        if (signal.aborted) throw new Error('这轮聊天已停止');
        const calls = response.toolCalls ?? [];
        modelRequest.finish_reason = response.receipt?.finish_reason ?? null;
        modelRequest.toolNames = calls.map(call => call.function?.name).filter(Boolean);
        this.store.recordContext(run.sessionId, context);
        if (response.receipt?.finish_reason === 'length') throw new Error('这轮回复达到了模型长度上限');
        let decoded;
        try {
          decoded = decodeChatOutput(response.content || streamed, {
            allowEmpty: calls.length > 0,
            maxMessages: calls.length ? 1 : 32,
          });
        } catch (error) {
          if (!(error instanceof ReplyFormatError)) throw error;
          if (calls.length) decoded = { messages: [], format: 'tool-ack-fallback' };
          else {
            modelRequest.replyFormat = 'invalid';
            this.store.recordContext(run.sessionId, context);
            if (formatRepairUsed || round === 4) throw error;
            // One semantic format correction, never a network retry. Preserve
            // original inputs and tool results; do not echo rejected output or
            // re-execute tools. Both paid calls keep their usage records.
            formatRepairUsed = true;
            repairingFormat = true;
            messages[0] = { ...messages[0], content: requestSystem + '\n\n【本轮格式修正】上一份结果未通过格式校验。请直接重新回答当前问题，只输出 {"messages":["要展示的消息"]}。纯文本要求放在字符串里，不输出空白。不再调用工具；已有工具结果直接复用。' };
            continue;
          }
        }
        modelRequest.replyFormat = decoded.format;
        this.store.recordContext(run.sessionId, context);
        // Check decoded text too: JSON escaping must not bypass the backstop.
        const guarded = decoded.messages.map(text => {
          const boundary = boundaryForRun();
          const visible = boundary.push(text) + boundary.finish();
          return { text: visible, blocked: boundary.blocked };
        });
        if (guarded.some(part => part.blocked)) {
          publishPart('我可以说说自己会做什么。你想聊点什么？', 'answer');
          answered = true;
          break;
        }
        if (calls.length === 0) {
          for (const part of guarded) publishPart(part.text, 'answer');
          answered = guarded.length > 0;
          break;
        }
        if (round === 4) throw new Error('这轮工具调用尚未完成，请重试问题');
        if (calls.some(call => !call?.id || !call.function?.name || typeof call.function.arguments !== 'string')) {
          throw new Error('模型返回了不完整的工具调用');
        }
        const presentation = toolPresentation(calls, guarded[0]?.text ?? '');
        if (!acknowledged) {
          publishPart(presentation.acknowledgement, 'acknowledgement');
          acknowledged = true;
        }
        emit({ type: 'tool_status', status: 'running', label: presentation.label });
        messages.push({ role: 'assistant', content: response.content || null, tool_calls: calls });
        for (const call of calls) {
          if (signal.aborted) throw new Error('这轮聊天已停止');
          const name = call.function.name;
          let args;
          let result;
          const index = context.toolCalls.length;
          let toolUsage = null;
          const usageKey = `tool:${run.runId}:${index}`;
          const recordTool = ({ phase, receipt, model, metrics, status = 'succeeded' }) => {
            toolUsage = this.accountUsage({
              key: usageKey, sessionId: run.sessionId, runId: run.runId, kind: 'search', name, id: call.id, index,
              receipt, model: model || this.model.searchModel || this.search?.metadata?.endpoint || null,
              pending: phase === 'start', status, metrics,
            });
            emit({ type: 'tool_usage', sessionId: run.sessionId, call: toolUsage });
            this.emitUsage(emit, run.sessionId);
          };
          emit({ type: 'tool_usage', sessionId: run.sessionId, call: {
            id: call.id, index, name, model: name === 'search_web' ? this.model.searchModel || this.search?.metadata?.endpoint || null : null,
            pending: true, status: 'running', inputTokens: null, outputTokens: null, totalTokens: null,
            modelCostCny: null, toolCostCny: null, totalCostCny: null,
          } });
          try {
            if (call.function.arguments.length > 16_000) throw new Error('工具参数过长');
            args = JSON.parse(call.function.arguments);
            const key = JSON.stringify([name, args]);
            if (sent.has(key) || context.toolCalls.length >= 8) result = { status: 'unavailable', error: '这轮工具已经调用过或达到调用范围' };
            else {
              sent.add(key);
              result = await runner(name, args, { onUsage: recordTool });
            }
          } catch {
            result = { status: 'invalid', error: '模型返回了无法读取的工具参数' };
          }
          if (Object.hasOwn(characterMediaTools, name) && result.attachment) {
            attachment = result.attachment;
            result = { ok: true, delivered: attachment.kind };
            emit({ type: 'character_media', attachment });
          }
          if (!toolUsage) {
            const mediaKind = characterMediaTools[name];
            toolUsage = this.accountUsage({
              key: usageKey, sessionId: run.sessionId, runId: run.runId, kind: mediaKind ? 'character_media' : 'local_tool',
              name, id: call.id, index, model: mediaKind === 'photo' ? 'qwen-image-2.1' : mediaKind === 'video' ? 'pika-h3-flex' : null,
              local: !mediaKind, ...(mediaKind && result.ok !== true ? { status: 'failed' } : {}),
            });
            emit({ type: 'tool_usage', sessionId: run.sessionId, call: toolUsage });
            this.emitUsage(emit, run.sessionId);
          }
          context.toolCalls.push({ name, arguments: args ?? null, result, usage: toolUsage });
          if (name === 'search_web' && result.ok === true && result.results?.length) context.previousWebSearch = result;
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          this.store.recordContext(run.sessionId, context);
        }
        emit({ type: 'tool_status', status: 'complete', label: '正在整理回复…' });
      }
      if (!answered) throw new Error(acknowledged ? '模型没有返回本轮操作的结果' : '模型没有返回可展示的回复');
      this.store.finishChat(run, { reply, parts, attachment }, this.now());
      this.emitUsage(emit, run.sessionId);
      emit({ type: 'done', sessionId: run.sessionId });
    } catch (error) {
      const message = signal.aborted ? '这轮聊天已停止' : this.publicError(error, '本轮聊天失败');
      this.store.finishChat(run, { reply, parts, attachment, error: message }, this.now());
      this.emitUsage(emit, run.sessionId);
      emit({ type: 'error', message });
    } finally {
      if (context) {
        context.durationMs = Math.round(performance.now() - started);
        this.store.recordContext(run.sessionId, context);
      }
      this.tick();
    }
  }

  publicError(error, fallback) {
    if (error instanceof SyntaxError) return fallback + '：模型返回的结构无法解析';
    const message = typeof error?.message === 'string' ? error.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) : '';
    return message || fallback;
  }

  async stop({ drain = false } = {}) {
    this.stopped = true;
    clearTimeout(this.timer);
    if (!drain) {
      this.backgroundController?.abort();
      this.briefController?.abort();
      for (const { controller } of this.chatRuns) controller.abort();
    }
    await Promise.allSettled([this.worker, this.briefWorker, ...[...this.chatRuns].map(run => run.running)].filter(Boolean));
  }
}
