import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { videoVoiceIdForAgent } from './agent-voice.mjs';
import { serviceClanConnection } from './service-clan.mjs';
import { compileSharePhoto } from './share-photo.mjs';
import { compileShareVideo, maxVideoSeconds, resolveVideoDuration } from './share-video.mjs';

const assets = new URL('../public/assets/', import.meta.url);
const pikaOrigin = 'https://api.dev.pika.art';
const photoGateway = {
  serviceId: 'gpu-qwen-image-21-app-production',
  origin: 'https://8.137.116.27:5889',
  model: 'qwen-image-2.1',
  contract: 'wanwen-viggle9-1',
};
const photoTerminalStatuses = new Set(['succeeded', 'failed', 'blocked', 'canceled', 'cancelled', 'expired']);
const mediaTypes = { photo: 'image/png', video: 'video/mp4' };
const limits = { photo: 12 * 1024 ** 2, video: 32 * 1024 ** 2 };
const mediaIdPattern = /^[a-f0-9]{48}$/;
const portraits = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const runFile = promisify(execFile);
const videoResolution = '480p';
const videoRates = {
  reference: { mode: 'reference-to-video', unitMicroUsd: 30_000 },
  text: { mode: 'text-to-video', unitMicroUsd: 10_000 },
};

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid media job ID');
  return value;
}

function pikaAssetUrl(raw, upload = false) {
  const url = new URL(raw);
  const host = url.hostname;
  const pika = host === 'pika.art' || host.endsWith('.pika.art');
  const signedUpload = upload && host.endsWith('.r2.cloudflarestorage.com');
  if (url.protocol !== 'https:' || url.username || url.password || !(pika || signedUpload)) {
    throw new Error('Unexpected Pika asset origin');
  }
  return url;
}

async function checkedFetch(url, options, fetcher = fetch) {
  const response = await fetcher(url, { ...options, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Media service HTTP ' + response.status);
  }
  return response;
}

async function json(url, options, fetcher) {
  return (await checkedFetch(url, options, fetcher)).json();
}

async function poll(read, terminal, signal) {
  for (;;) {
    const state = await read();
    if (terminal(state)) return state;
    await delay(2500, undefined, { signal });
  }
}

function portraitFile(path) {
  if (typeof path !== 'string' || !/^\/assets\/[a-z\d_-]+\.(png|jpe?g|webp|svg)$/i.test(path)) return null;
  return path.slice('/assets/'.length).replace(/\.svg$/i, '.png');
}

async function portraitFor(path) {
  const file = portraitFile(path);
  if (!file) return null;
  const type = portraits[file.split('.').at(-1).toLowerCase()];
  try {
    const data = await readFile(new URL(file, assets));
    return data.length > 0 && data.length <= limits.photo ? { file, type, data } : null;
  } catch {
    return null;
  }
}

async function photoReferenceBoard(images, directory, ffmpeg, signal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(directory, '.references-'));
  try {
    const paths = images.map((_, index) => join(temp, `input-${index}`));
    await Promise.all(paths.map((path, index) => writeFile(path, images[index].data, { mode: 0o600, signal })));
    const [width, height] = images.length === 2 ? [320, 384] : [256, 320];
    const filters = paths.map((_, index) =>
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x303030,setsar=1,format=rgb24[p${index}]`);
    filters.push(paths.map((_, index) => `[p${index}]`).join('') + `hstack=inputs=${paths.length}[board]`);
    const file = 'reference-board.png';
    const output = join(temp, file);
    await runFile(ffmpeg, ['-nostdin', '-v', 'error', ...paths.flatMap(path => ['-i', path]),
      '-filter_complex_threads', '1', '-filter_complex', filters.join(';'), '-map', '[board]',
      '-frames:v', '1', '-update', '1', output], { signal });
    return { file, type: mediaTypes.photo, data: await readFile(output, { signal }) };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function generatePhoto(connection, { portrait, references, photoPlan, requestId, directory, ffmpeg, signal, onPrompt }) {
  const base = photoGateway.origin;
  if (connection.base_url !== base || connection.model !== photoGateway.model) throw new Error('Unexpected GPU service contract');
  const headers = connection.headers;
  const inputs = [];
  const images = [...(portrait ? [portrait] : []), ...references.map(reference => reference.image)];
  const combined = images.length > 1;
  const image = combined ? await photoReferenceBoard(images, directory, ffmpeg, signal) : images[0];
  if (image) {
    const form = new FormData();
    form.append('file', new Blob([image.data], { type: image.type }), image.file);
    const upload = await json(base + '/api/v2/assets/images', { method: 'POST', headers, body: form, signal });
    inputs.push({ role: 'reference_image', asset_id: identifier(upload.asset_id) });
  }
  const parameters = { mode: image ? 'i2i' : 't2i', ...compileSharePhoto(photoPlan) };
  signal.throwIfAborted();
  onPrompt?.(parameters.prompt);
  const submitted = await json(base + '/api/v2/jobs', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': requestId,
      'X-Online-Capability': 'image-generation' }, signal,
    body: JSON.stringify({ model_id: photoGateway.model, operation: 'image.generate', contract_version: photoGateway.contract,
      client_job_id: requestId, parameters, inputs }),
  });
  const path = base + '/api/v2/jobs/' + identifier(submitted.job_id);
  const job = await poll(() => json(path, { headers, signal }),
    state => state.terminal === true || photoTerminalStatuses.has(state.status), signal);
  if (job.status !== 'succeeded') throw new Error('GPU image job failed');
  const outputPath = path + '/outputs';
  const readyImage = state => state.items.find(item => (item.output_type === 'image' || item.output_id === 'image') &&
    item.delivery_state === 'ready' && item.media_type === 'image/png');
  const outputs = await poll(() => json(outputPath, { headers, signal }), readyImage, signal);
  const outputId = identifier(readyImage(outputs).output_id);
  return checkedFetch(outputPath + '/' + outputId + '/content', { headers, signal });
}

async function uploadPikaAsset(base, headers, media, signal, pikaFetch) {
  const upload = await json(base + '/v1/media/uploads', { method: 'POST', headers, signal,
    body: JSON.stringify({ content_type: media.type, size_bytes: media.data.length }) }, pikaFetch);
  const uploadHeaders = new Headers({ 'Content-Type': media.type });
  for (const [name, value] of Object.entries(upload.headers ?? {})) {
    if (/^(content-type|content-length|cache-control|x-amz-[a-z0-9-]+)$/i.test(name) && typeof value === 'string') {
      uploadHeaders.set(name, value);
    }
  }
  await checkedFetch(pikaAssetUrl(upload.upload_url, true), {
    method: 'PUT', headers: uploadHeaders, body: media.data, signal,
  }, pikaFetch);
  return pikaAssetUrl(upload.url).href;
}

function pikaBilling({ billing, status }) {
  const actualMicroUsd = billing?.charge_micro_usd;
  if (billing?.state === 'settled' && Number.isSafeInteger(actualMicroUsd) && actualMicroUsd >= 0) {
    return { state: 'settled', actualMicroUsd };
  }
  const pending = billing?.state === 'pending' || (billing == null && status === 'completed');
  return { state: pending ? 'pending' : 'unavailable', actualMicroUsd: null };
}

function videoReceiptProof(token, jobId) {
  return createHmac('sha256', token).update('chat-lab:pika-billing:' + jobId).digest('hex');
}

function pikaHeaders(connection) {
  if (connection.base_url !== pikaOrigin || connection.model !== 'pika-h3-flex') throw new Error('Unexpected Pika service contract');
  return { ...connection.headers, 'Content-Type': 'application/json' };
}

async function generateVideo(connection, { images, voice, mode, prompt, duration, aspectRatio, requestId, signal, updateBilling, onPrompt, pikaFetch }) {
  const base = pikaOrigin;
  const headers = pikaHeaders(connection);
  const [imageUrls, audioUrl] = await Promise.all([
    Promise.all(images.map(image => uploadPikaAsset(base, headers, image, signal, pikaFetch))),
    voice ? uploadPikaAsset(base, headers, voice, signal, pikaFetch) : null,
  ]);
  const references = imageUrls.map(url => ({ type: 'image', url }));
  if (audioUrl) references.push({ type: 'audio', url: audioUrl });
  signal.throwIfAborted();
  onPrompt?.(prompt);
  const submitted = await json(base + '/v1/media/pika/pika-h3-flex/' + mode, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': requestId }, signal,
    body: JSON.stringify({ prompt, duration, resolution: videoResolution, aspect_ratio: aspectRatio,
      rewrite: false, ...(references.length ? { references } : {}) }),
  }, pikaFetch);
  const jobId = identifier(submitted.id);
  const path = '/v1/media/jobs/' + jobId;
  updateBilling({ jobId, state: 'pending' });
  const job = await poll(() => json(base + path, { headers, signal }, pikaFetch),
    state => ['completed', 'failed', 'cancelled'].includes(state.status), signal);
  updateBilling(pikaBilling(job));
  if (job.status !== 'completed') throw new Error('Pika video job failed');
  return checkedFetch(pikaAssetUrl(job.output?.video?.url), { signal }, pikaFetch);
}

async function synthesizeFixedVoice(connection, speaker, dialogue, signal) {
  const endpoint = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse';
  const headers = new Headers(connection.headers);
  if (connection.base_url !== new URL(endpoint).origin || headers.get('X-Api-Resource-Id') !== 'seed-icl-2.0') {
    throw new Error('Unexpected fixed voice service contract');
  }
  headers.set('X-Api-Request-Id', randomUUID());
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'text/event-stream');
  const rate = 24_000;
  const response = await checkedFetch(endpoint, { method: 'POST', headers, signal,
    body: JSON.stringify({ user: { uid: 'chatlab-video' }, namespace: 'BidirectionalTTS', req_params: {
      text: dialogue, model: 'seed-tts-2.0-expressive', speaker,
      audio_params: { format: 'pcm', sample_rate: rate, speech_rate: 25 },
    } }) });
  let total = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > 1024 ** 2) throw new Error('Fixed voice response too large');
    chunks.push(chunk);
  }
  const frames = Buffer.concat(chunks).toString('utf8').split(/\r?\n\r?\n/);
  const audio = [];
  let done = false;
  for (const frame of frames) {
    const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!payload || payload === '[DONE]') continue;
    const item = JSON.parse(payload);
    const code = Number(item.code ?? 0);
    if (code === 20000000) done = true;
    else if (code !== 0) throw new Error('Fixed voice synthesis rejected');
    const data = typeof item.data === 'string' ? item.data : item.audio || item.data?.audio || item.audio_data;
    if (typeof data === 'string' && data.length) audio.push(Buffer.from(data, 'base64'));
  }
  const pcm = Buffer.concat(audio);
  if (!done || !pcm.length || pcm.length % 2) throw new Error('Incomplete fixed voice response');
  const seconds = pcm.length / (2 * rate);
  if (seconds > maxVideoSeconds) return { seconds };
  // Pika requires at least two seconds per audio reference. Preserve the speech
  // timing by padding quiet samples at the end instead of changing its speed.
  const size = Math.max(pcm.length, 2 * rate * 2);
  const wav = Buffer.alloc(44 + size);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(size + 36, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(size, 40);
  pcm.copy(wav, 44);
  return { seconds, type: 'audio/wav', data: wav };
}

async function mediaBytes(response, kind) {
  if (!response.body || Number(response.headers.get('content-length')) > limits[kind]) throw new Error('Invalid media size');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limits[kind]) throw new Error('Media too large');
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks, size);
  const valid = kind === 'photo' ? data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    : data.subarray(4, 8).toString('ascii') === 'ftyp';
  if (!valid) throw new Error('Unexpected media format');
  return data;
}

async function finishVideo(data, directory, ffmpeg, duration, signal, offCameraVoice) {
  const temp = await mkdtemp(join(directory, '.trim-'));
  const input = join(temp, 'in.mp4');
  const output = join(temp, 'out.mp4');
  try {
    await writeFile(input, data, { mode: 0o600, signal });
    let audio = ['-map', '0:a:0?'];
    if (offCameraVoice) {
      const voiceFile = join(temp, 'voice.wav');
      await writeFile(voiceFile, offCameraVoice.data, { mode: 0o600, signal });
      const { stdout } = await runFile('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=index', '-of', 'csv=p=0', input], { signal });
      audio = ['-i', voiceFile, ...(stdout.trim()
        ? ['-filter_complex', '[0:a:0]volume=-18dB[ambient];[1:a:0]highpass=f=300,lowpass=f=3400,apad[voice];[ambient][voice]amix=inputs=2:duration=first:normalize=0[location]', '-map', '[location]']
        : ['-map', '1:a:0', '-af', 'highpass=f=300,lowpass=f=3400,apad'])];
    }
    await runFile(ffmpeg, ['-nostdin', '-v', 'error', '-i', input, ...audio, '-map', '0:v:0',
      '-t', String(duration), '-r', '24', '-vf', 'scale=486:864:force_original_aspect_ratio=increase,crop=486:864,setsar=1',
      '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', '-movflags', '+faststart', output], { signal });
    return await readFile(output);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export function createCharacterMedia({ tokenFile, directory, ffmpeg = 'ffmpeg', pikaRelay }) {
  const accessToken = async () => (await readFile(tokenFile, 'utf8')).trim();
  async function connection(id, signal, token) {
    return serviceClanConnection(id, { token: token ?? await accessToken(), signal });
  }
  const configured = new Set();
  const services = { photo: photoGateway.serviceId, video: 'pika-h3-flex' };

  async function photoRecord(assetId, sessionId) {
    if (typeof assetId !== 'string' || !mediaIdPattern.test(assetId)) return null;
    const file = resolve(directory, assetId + '.photo');
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size < 8 || info.size > limits.photo) return null;
    } catch { return null; }
    try {
      const details = JSON.parse(await readFile(file + '.json', 'utf8'));
      return details.sessionId === sessionId ? { file, details } : null;
    } catch (error) {
      // Older photos have no generation metadata. Their saved message is still a usable reference.
      return error.code === 'ENOENT' ? { file } : null;
    }
  }

  return {
    async readVideoBilling(jobId, proof, signal) {
      identifier(jobId);
      if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return { state: 'unavailable', actualMicroUsd: null };
      const token = await accessToken();
      // Workspace snapshots are client-owned. Only query jobs issued by this server.
      if (!timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(videoReceiptProof(token, jobId), 'hex'))) {
        return { state: 'unavailable', actualMicroUsd: null };
      }
      if (!pikaRelay?.available()) return null;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
      const headers = pikaHeaders(await connection(services.video, deadline, token));
      const job = await json(pikaOrigin + '/v1/media/jobs/' + jobId, { headers, signal: deadline }, pikaRelay.pikaFetch);
      return pikaBilling(job);
    },
    async refresh() {
      const results = await Promise.all(Object.entries(services).map(async ([kind, id]) => {
        try {
          if (kind === 'video') {
            if (!pikaRelay) return null;
            await runFile(ffmpeg, ['-version'], { timeout: 2500 });
          }
          await connection(id, AbortSignal.timeout(2500));
          return kind;
        } catch { return null; }
      }));
      configured.clear();
      for (const kind of results) if (kind) configured.add(kind);
    },
    available(kind, agent) {
      return configured.has(kind) && Boolean(agent);
    },
    async photoReferences(history, sessionId) {
      const seen = new Set();
      const candidates = [];
      for (let i = history.length - 1; i >= 0 && candidates.length < 8; i--) {
        const { role, attachment, text } = history[i];
        if (role !== 'assistant' || attachment?.kind !== 'photo' || seen.has(attachment.id)) continue;
        seen.add(attachment.id);
        candidates.push({ assetId: attachment.id, text, index: i });
      }
      const photos = await Promise.all(candidates.map(async ({ assetId, text, index }) => {
        const record = await photoRecord(assetId, sessionId);
        if (!record) return null;
        if (record.details) {
          const { scene, framing, templateId, keptDetails } = record.details;
          return { assetId, scene, framing, ...(templateId ? { templateId } : {}), ...(keptDetails?.length ? { keptDetails } : {}) };
        }
        const request = history.slice(0, index).findLast(message => message.role === 'user')?.text;
        return { assetId, reply: text.slice(0, 96), ...(request ? { request: request.slice(0, 160) } : {}) };
      }));
      return photos.filter(Boolean).map((photo, index) => ({ id: `photo-${index + 1}`, ...photo }));
    },
    async generate(kind, { agent, framing, scene, photoPlan, videoPlan, references = [], runId, sessionId, signal, onUsage, onPrompt }) {
      const video = kind === 'video';
      if (video && !pikaRelay?.available()) return { ok: false, error: '成都 → 新加坡视频隧道不可用' };
      if (!video && !photoPlan) return { ok: false, error: '照片缺少可用机位模板' };
      if (video && !videoPlan) return { ok: false, error: '视频缺少可用机位模板' };
      const includePortrait = (video ? videoPlan : photoPlan).includePortrait;
      const portrait = includePortrait ? await portraitFor(agent.metadata?.card?.portrait) : null;
      if (includePortrait && !portrait) return { ok: false, error: '角色还没有设定图，无法生成角色入镜的影像' };
      const dialogue = videoPlan?.spokenLine;
      const onCamera = videoPlan?.vocalMode === 'ON_CAMERA_LIPSYNC';
      const videoParams = videoPlan?.template.pika_params;
      let duration = videoPlan?.duration;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(video ? 300_000 : 180_000)]);
      let billing = null;
      let videoToken;
      const reportBilling = (phase, status) => onUsage?.({ phase, status, model: 'pika-h3-flex',
        receipt: { provider_id: billing.jobId }, mediaBilling: billing });
      let completed = false;
      try {
        const requestId = 'chatlab-' + createHash('sha256').update(runId).digest('hex').slice(0, 40);
        const previousPhotos = await Promise.all(references.map(async ({ assetId, keep }) => {
          const record = await photoRecord(assetId, sessionId);
          if (!record) return null;
          const data = await readFile(record.file, { signal: deadline });
          return { keep, image: { file: assetId + '.png', type: mediaTypes.photo, data } };
        }));
        if (previousPhotos.includes(null)) return { ok: false, error: '会话里的参考照片已不可用' };
        let voice;
        const speaker = video && dialogue && videoVoiceIdForAgent(agent);
        if (speaker) {
          try {
            voice = await synthesizeFixedVoice(await connection('volc-icl20-sse', deadline), speaker, dialogue, deadline);
          } catch {
            return { ok: false, error: deadline.aborted ? '固定音色合成未完成' : '固定音色合成失败，视频尚未提交' };
          }
          if (voice.seconds > maxVideoSeconds) return { ok: false, error: '固定音色台词超过 6 秒，请缩短台词后再试' };
          duration = resolveVideoDuration(videoParams.default_duration, dialogue, voice.seconds);
        }
        if (video) {
          const rate = portrait || previousPhotos.length || (onCamera && voice) ? videoRates.reference : videoRates.text;
          billing = { ...rate, currency: 'USD', resolution: videoResolution, duration, fixedVoiceSeconds: voice?.seconds ?? null,
            source: `https://dev.pika.art/models/pika/pika-h3-flex/${rate.mode}/pricing`, checkedAt: '2026-11-24',
            estimatedMicroUsd: duration * rate.unitMicroUsd, actualMicroUsd: null, jobId: null, state: 'estimate' };
          reportBilling('start');
        }
        if (video) videoToken = await accessToken();
        const provider = await connection(services[kind], deadline, videoToken);
        const offCameraVoice = !onCamera && voice;
        const referenceVoice = onCamera ? voice : null;
        const response = video
          ? await generateVideo(provider, { images: [...(portrait ? [portrait] : []), ...previousPhotos.map(photo => photo.image)],
            voice: referenceVoice, mode: billing.mode,
            prompt: compileShareVideo(videoPlan, { referenceVoice, offCameraVoice }),
            duration, aspectRatio: videoParams.aspect_ratio, requestId, signal: deadline, onPrompt, pikaFetch: pikaRelay.pikaFetch,
            updateBilling: fields => { billing = { ...billing, ...fields }; } })
          : await generatePhoto(provider, { portrait, references: previousPhotos, photoPlan, requestId, directory, ffmpeg, signal: deadline, onPrompt });
        let data = await mediaBytes(response, kind);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (video) data = await finishVideo(data, directory, ffmpeg, duration, deadline, offCameraVoice);
        if (data.length > limits[kind]) throw new Error('Media too large');
        const mediaId = randomBytes(24).toString('hex');
        const file = resolve(directory, mediaId + '.' + kind);
        await writeFile(file, data, { mode: 0o600, flag: 'wx' });
        if (!video && sessionId) {
          try {
            const keptDetails = previousPhotos.map(({ keep }) => keep);
            await writeFile(file + '.json', JSON.stringify({ sessionId, framing, scene, templateId: photoPlan.template.template_id, keptDetails }),
              { mode: 0o600, flag: 'wx' });
          } catch (error) {
            await rm(file, { force: true });
            throw error;
          }
        }
        completed = true;
        return { ok: true, attachment: { id: mediaId, kind } };
      } catch (error) {
        if (signal.aborted) return { ok: false, error: '本轮已停止' };
        if (deadline.aborted) return { ok: false, error: '生成等待超时' };
        if (error?.code === 'SSH_RELAY_UNAVAILABLE') return { ok: false, error: '成都 → 新加坡视频隧道不可用' };
        return { ok: false, error: /^Media service HTTP \d{3}$/.test(error?.message)
          ? error.message : '角色影像生成失败' };
      } finally {
        if (billing?.state === 'pending' && billing.jobId && videoToken) {
          billing = { ...billing, receiptProof: videoReceiptProof(videoToken, billing.jobId) };
        }
        if (billing) reportBilling('complete', completed ? 'succeeded' : 'failed');
      }
    },
    async asset(id, kind) {
      if (!mediaIdPattern.test(id) || !Object.hasOwn(mediaTypes, kind)) return null;
      const file = resolve(directory, id + '.' + kind);
      try {
        const info = await stat(file);
        return info.isFile() && info.size <= limits[kind] ? { file, size: info.size, type: mediaTypes[kind] } : null;
      } catch { return null; }
    },
  };
}

export function isCharacterAttachment(value) {
  return value && Object.keys(value).length === 2 &&
    typeof value.id === 'string' && mediaIdPattern.test(value.id) && Object.hasOwn(mediaTypes, value.kind);
}
