import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { videoVoiceIdForAgent } from './agent-voice.mjs';

const assets = new URL('../public/assets/', import.meta.url);
const serviceClan = 'http://127.0.0.1:47391';
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
const speechCharactersPerSecond = 4.7;
const maxVideoSeconds = 5;
const videoResolution = '480p';
const videoRates = {
  reference: { mode: 'reference-to-video', unitMicroUsd: 30_000 },
  text: { mode: 'text-to-video', unitMicroUsd: 10_000 },
};
export const maxVideoDialogueCharacters = Math.floor(maxVideoSeconds * speechCharactersPerSecond);

export function plannedVideoDuration(actionSeconds, dialogue = '') {
  const characters = dialogue.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return Math.max(actionSeconds, Math.ceil(characters / speechCharactersPerSecond));
}
const selfieFrameLook = [
  'One candid front-camera smartphone image of the character in <image1>, held at arm’s length with one hand and made for the person in the chat. Use the reference for identity, preserving age, face and distinctive features, rendered as real photography.',
  'Show the upper body and what is happening nearby. Frame slightly off-center with a small natural tilt, as if captured mid-gesture. Keep the phone out of sight and the face and relevant objects readable.',
  'Use actual light sources in the scene, uneven highlights and soft shadow transitions. Preserve real skin and surface texture, subtle sensor grain in the shadows and a hint of handheld softness. Natural phone colors, no text, watermark, beauty filter, studio setup or heavy grain. Avoid showing the actual phone unless taking a selfie from back camera facing a mirror like reflection',
].join('\n');
const subjectLook = 'An everyday handheld rear-camera smartphone capture. Frame the described subject so its appearance, context or action is easy to see. The operator stays off-camera; the role, their reflection and their hands are outside the frame. Keep other people out of the shot. Use practical light, natural exposure and shadow texture, subtle sensor grain, slight handheld imperfection and ordinary phone colors. No editorial finish, overlay or staging.';

function continuityPrompt(references, name) {
  return references.map(({ keep }, index) => `${name(index)}: preserve these details from the reference: ${keep}`).join('\n');
}

function characterVideoPrompt(framing, scene, motion, duration, dialogue, ambience, voiceReference, references) {
  const selfie = framing === 'selfie';
  const speaker = selfie ? 'The on-camera character' : 'The unseen phone operator';
  const voice = voiceReference
    ? `Use the supplied speech recording to guide the sole on-camera character's voice, timing and lip movement. The character says exactly: ${JSON.stringify(dialogue)}. Keep the recorded delivery and finish within the shot.`
    : dialogue
    ? `${speaker} alone says exactly this line: ${JSON.stringify(dialogue)}. Start speaking promptly, at about ${speechCharactersPerSecond} spoken characters per second. Finish within the shot, with natural inflection.${selfie ? ' Match the lip movement.' : ''}`
    : 'Nobody speaks in the generated audio.';
  return [
    selfie ? 'Identity: Use reference image 1 for character identity. Preserve the face, age, hair, species and distinctive features in photorealistic live action. Keep animal or fantasy characters recognizable as their own species. Compose a new image for the described scene. The character holds the front camera at arm’s length and films a quick update for the viewer.' : subjectLook,
    ...(references.length ? ['Visual continuity: Match the specified details in the earlier photos. Follow the new camera angle, framing and action.',
      continuityPrompt(references, index => `Reference image ${index + (selfie ? 2 : 1)}`)] : []),
    selfie ? 'Camera: One continuous 9:16 handheld selfie, with small irregular wrist sway and a slight natural tilt when the character moves. Keep the face readable and the relevant object in frame. No cuts or artificial zoom.'
      : 'Camera: One continuous 9:16 phone shot, with slight wrist movement and a short intentional pan or close look only if it reveals the subject. No cuts or artificial zoom. The subject remains clear.',
    `Pacing: Use ${duration} seconds. Begin the visible action within the first half-second. Complete one clear movement at natural speed and use any remaining time for a brief reaction. Keep the moment brisk without a long lead-in or dead time.`,
    'Light and texture: Subtle smartphone sensor noise in the shadows, a small exposure adjustment as the phone angle changes, and shifting practical highlights. Keep color and motion natural. No captions or graphics.',
    `Scene: ${scene}`,
    `Action: ${motion}`,
    `Dialogue: ${voice}`,
    `Background and foley: ${ambience || 'A faint natural noise floor from this location and soft sounds that follow the visible action.'} Capture it as quiet location sound on the phone microphone. Keep it underneath the character if they speak. No other speakers, distant conversations, device voices, narration, singing or music.`,
  ].join('\n');
}

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

async function checkedFetch(url, options) {
  const response = await fetch(url, { ...options, redirect: 'error' });
  if (!response.ok) throw new Error('Media service HTTP ' + response.status);
  return response;
}

async function json(url, options) {
  return (await checkedFetch(url, options)).json();
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

async function generatePhoto(connection, { portrait, references, scene, requestId, directory, ffmpeg, signal }) {
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
  const look = portrait ? selfieFrameLook.replace('<image1>',
    combined ? 'panel 1 of <image1> (the leftmost identity reference)' : '<image1>') : subjectLook;
  const referenceNotes = references.length
    ? `\nVisual continuity: ${combined ? '<image1> is a reference board. Panels are numbered from left to right. Compose one seamless photo without panels or borders. ' : ''}Follow the new camera angle and framing.\n${continuityPrompt(references,
      index => combined ? `Panel ${index + (portrait ? 2 : 1)}` : '<image1>')}`
    : '';
  const parameters = { mode: image ? 'i2i' : 't2i',
    prompt: `Vertical ${portrait ? '9:16' : '3:4'}. ${look}\nScene: ${scene}${referenceNotes}`,
    width: portrait ? 576 : 768, height: 1024 };
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

async function uploadPikaAsset(base, headers, media, signal) {
  const upload = await json(base + '/v1/media/uploads', { method: 'POST', headers, signal,
    body: JSON.stringify({ content_type: media.type, size_bytes: media.data.length }) });
  const uploadHeaders = new Headers({ 'Content-Type': media.type });
  for (const [name, value] of Object.entries(upload.headers ?? {})) {
    if (/^(content-type|content-length|cache-control|x-amz-[a-z0-9-]+)$/i.test(name) && typeof value === 'string') {
      uploadHeaders.set(name, value);
    }
  }
  await checkedFetch(pikaAssetUrl(upload.upload_url, true), {
    method: 'PUT', headers: uploadHeaders, body: media.data, signal,
  });
  return pikaAssetUrl(upload.url).href;
}

async function generateVideo(connection, { images, voice, mode, prompt, duration, requestId, signal, updateBilling }) {
  const base = 'https://api.dev.pika.art';
  if (connection.base_url !== base || connection.model !== 'pika-h3-flex') throw new Error('Unexpected Pika service contract');
  const headers = { ...connection.headers, 'Content-Type': 'application/json' };
  const [imageUrls, audioUrl] = await Promise.all([
    Promise.all(images.map(image => uploadPikaAsset(base, headers, image, signal))),
    voice ? uploadPikaAsset(base, headers, voice, signal) : null,
  ]);
  const references = imageUrls.map(url => ({ type: 'image', url }));
  if (audioUrl) references.push({ type: 'audio', url: audioUrl });
  const submitted = await json(base + '/v1/media/pika/pika-h3-flex/' + mode, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': requestId }, signal,
    body: JSON.stringify({ prompt, duration, resolution: videoResolution, aspect_ratio: '9:16',
      rewrite: false, ...(references.length ? { references } : {}) }),
  });
  const jobId = identifier(submitted.id);
  const path = '/v1/media/jobs/' + jobId;
  updateBilling({ jobId, state: 'pending' });
  const job = await poll(() => json(base + path, { headers, signal }),
    state => ['completed', 'failed', 'cancelled'].includes(state.status), signal);
  const saveBilling = ({ billing }) => {
    const actual = billing?.charge_micro_usd;
    if (billing?.state === 'settled' && Number.isSafeInteger(actual) && actual >= 0) {
      updateBilling({ state: 'settled', actualMicroUsd: actual });
    } else updateBilling({ state: billing?.state === 'pending' ? 'pending' : 'unavailable' });
  };
  saveBilling(job);
  if (job.billing?.state === 'pending') {
    for (const delayMs of [1000, 2000, 5000]) {
      await delay(delayMs, undefined, { signal });
      try {
        const checked = await json(base + path, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
        saveBilling(checked);
        if (checked.billing?.state !== 'pending') break;
      } catch { break; }
    }
  }
  if (job.status !== 'completed') throw new Error('Pika video job failed');
  return checkedFetch(pikaAssetUrl(job.output?.video?.url), { signal });
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
        ? ['-filter_complex', '[0:a:0][1:a:0]amix=inputs=2:duration=first:normalize=0[location]', '-map', '[location]']
        : ['-map', '1:a:0'])];
    }
    await runFile(ffmpeg, ['-nostdin', '-v', 'error', '-i', input, ...audio, '-map', '0:v:0',
      '-t', String(duration), '-r', '24', '-vf', 'scale=486:864:force_original_aspect_ratio=increase,crop=486:864,setsar=1',
      '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', '-movflags', '+faststart', output], { signal });
    return await readFile(output);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export function createCharacterMedia({ tokenFile, directory, ffmpeg = 'ffmpeg' }) {
  async function connection(id, signal) {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    return json(serviceClan + '/api/services/' + id + '/connection', {
      headers: { 'X-Service-Clan-Token': token }, signal,
    });
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
    async refresh() {
      const results = await Promise.all(Object.entries(services).map(async ([kind, id]) => {
        try {
          if (kind === 'video') await runFile(ffmpeg, ['-version'], { timeout: 2500 });
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
          const { scene, framing, keptDetails } = record.details;
          return { assetId, scene, framing, ...(keptDetails?.length ? { keptDetails } : {}) };
        }
        const request = history.slice(0, index).findLast(message => message.role === 'user')?.text;
        return { assetId, reply: text.slice(0, 96), ...(request ? { request: request.slice(0, 160) } : {}) };
      }));
      return photos.filter(Boolean).map((photo, index) => ({ id: `photo-${index + 1}`, ...photo }));
    },
    async generate(kind, { agent, framing = 'selfie', scene, motion, duration, actionDuration, dialogue, ambience,
      references = [], runId, sessionId, signal, onUsage }) {
      const selfie = framing === 'selfie';
      const portrait = selfie ? await portraitFor(agent.metadata?.card?.portrait) : null;
      if (selfie && !portrait) return { ok: false, error: '角色还没有设定图，无法生成角色入镜的影像' };
      const video = kind === 'video';
      if (video && ![3, 4, 5].includes(duration)) return { ok: false, error: '短片时长须为 3、4 或 5 秒' };
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(video ? 300_000 : 180_000)]);
      let billing = null;
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
          duration = Math.max(actionDuration ?? duration, Math.ceil(voice.seconds));
          if (duration > maxVideoSeconds) return { ok: false, error: '固定音色台词超过 5 秒，请缩短台词后再试' };
        }
        if (video) {
          const rate = portrait || previousPhotos.length ? videoRates.reference : videoRates.text;
          billing = { ...rate, currency: 'USD', resolution: videoResolution, duration, fixedVoiceSeconds: voice?.seconds ?? null,
            source: `https://dev.pika.art/models/pika/pika-h3-flex/${rate.mode}/pricing`, checkedAt: '2026-11-23',
            estimatedMicroUsd: duration * rate.unitMicroUsd, actualMicroUsd: null, jobId: null, state: 'estimate' };
          reportBilling('start');
        }
        const provider = await connection(services[kind], deadline);
        const offCameraVoice = !selfie && voice;
        const referenceVoice = selfie ? voice : null;
        const response = video
          ? await generateVideo(provider, { images: [...(portrait ? [portrait] : []), ...previousPhotos.map(photo => photo.image)],
            voice: referenceVoice, mode: billing.mode,
            prompt: characterVideoPrompt(framing, scene, motion, duration, offCameraVoice ? undefined : dialogue, ambience,
              referenceVoice, previousPhotos),
            duration, requestId, signal: deadline, updateBilling: fields => { billing = { ...billing, ...fields }; } })
          : await generatePhoto(provider, { portrait, references: previousPhotos, scene, requestId, directory, ffmpeg, signal: deadline });
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
            await writeFile(file + '.json', JSON.stringify({ sessionId, framing, scene, keptDetails }), { mode: 0o600, flag: 'wx' });
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
        return { ok: false, error: /^Media service HTTP \d{3}$/.test(error?.message)
          ? error.message : '角色影像生成失败' };
      } finally {
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
