import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const assets = new URL('../public/assets/', import.meta.url);
const serviceClan = 'http://127.0.0.1:47391';
const mediaTypes = { photo: 'image/png', video: 'video/mp4' };
const limits = { photo: 12 * 1024 ** 2, video: 32 * 1024 ** 2 };
const mediaIdPattern = /^[a-f0-9]{48}$/;
const portraits = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const runFile = promisify(execFile);
const selfieFrameLook = [
  'One candid front-camera smartphone image of the character in <image1>, held at arm’s length with one hand and made for the person in the chat. Use the reference for identity, preserving age, face and distinctive features, rendered as real photography.',
  'Show the upper body and what is happening nearby. Frame slightly off-center with a small natural tilt, as if captured mid-gesture. Keep the phone out of sight and the face and relevant objects readable.',
  'Use actual light sources in the scene, uneven highlights and soft shadow transitions. Preserve real skin and surface texture, subtle sensor grain in the shadows and a hint of handheld softness. Natural phone colors, no text, watermark, beauty filter, studio setup or heavy grain.',
].join('\n');

function selfieVideoPrompt(motion, duration) {
  return [
    'Continuity: Start from the supplied first frame. Preserve identity, clothing, props and surroundings. The character holds the front camera at arm’s length and films a quick update for the viewer.',
    'Camera: One continuous 9:16 handheld selfie, with small irregular wrist sway and a slight natural tilt when the character moves. Keep the face readable and the relevant object in frame. No cuts or artificial zoom.',
    `Pacing: Use ${duration} seconds. Begin the visible action within the first half-second. Complete one clear movement at natural speed and use any remaining time for a brief reaction. Keep the moment brisk without a long lead-in or dead time.`,
    'Light and texture: Subtle smartphone sensor noise in the shadows, a small exposure adjustment as the phone angle changes, and shifting practical highlights. Keep color and motion natural. Quiet location sound only, no music, captions or graphics.',
    `Action in this selfie: ${motion}`,
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

async function generatePhoto(connection, { portrait, prompt, requestId, firstFrame, signal }) {
  const base = new URL(connection.base_url);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' ||
      base.search || base.hash || connection.model !== 'qwen-image-2.1') throw new Error('Unexpected GPU service contract');
  const headers = connection.headers;
  const form = new FormData();
  form.append('file', new Blob([portrait.data], { type: portrait.type }), portrait.file);
  const upload = await json(new URL('/api/assets/images', base), { method: 'POST', headers, body: form, signal });
  const submitted = await json(new URL('/api/jobs', base), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, signal,
    body: JSON.stringify({ model_id: connection.model, operation: 'image.generate', client_job_id: requestId,
      parameters: { mode: 'i2i', prompt, width: firstFrame ? 576 : 768, height: 1024, steps: 25, prompt_enhance: false },
      inputs: [{ role: 'reference_image', asset_id: identifier(upload.asset_id) }] }),
  });
  const path = '/api/jobs/' + identifier(submitted.job_id);
  const job = await poll(() => json(new URL(path, base), { headers, signal }), state => state.terminal === true, signal);
  if (job.status !== 'succeeded') throw new Error('GPU image job failed');
  return checkedFetch(new URL(path + '/outputs/image/content', base), { headers, signal });
}

async function generateVideo(connection, { frame, prompt, duration, requestId, signal }) {
  const base = 'https://api.dev.pika.art';
  if (connection.base_url !== base || connection.model !== 'pika-h3-flex') throw new Error('Unexpected Pika service contract');
  const headers = { ...connection.headers, 'Content-Type': 'application/json' };
  const upload = await json(base + '/v1/media/uploads', { method: 'POST', headers, signal,
    body: JSON.stringify({ content_type: 'image/png', size_bytes: frame.length }) });
  const uploadHeaders = new Headers({ 'Content-Type': 'image/png' });
  for (const [name, value] of Object.entries(upload.headers ?? {})) {
    if (/^(content-type|content-length|cache-control|x-amz-[a-z0-9-]+)$/i.test(name) && typeof value === 'string') {
      uploadHeaders.set(name, value);
    }
  }
  await checkedFetch(pikaAssetUrl(upload.upload_url, true), {
    method: 'PUT', headers: uploadHeaders, body: frame, signal,
  });
  const submitted = await json(base + '/v1/media/pika/pika-h3-flex/image-to-video', {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': requestId }, signal,
    body: JSON.stringify({ prompt, duration, resolution: '480p', aspect_ratio: '9:16',
      rewrite: false, image: pikaAssetUrl(upload.url).href }),
  });
  const path = '/v1/media/jobs/' + identifier(submitted.id);
  const job = await poll(() => json(base + path, { headers, signal }),
    state => ['completed', 'failed', 'cancelled'].includes(state.status), signal);
  if (job.status !== 'completed') throw new Error('Pika video job failed');
  return checkedFetch(pikaAssetUrl(job.output?.video?.url), { signal });
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

async function capVideoDuration(data, directory, ffmpeg, duration, signal) {
  const temp = await mkdtemp(join(directory, '.trim-'));
  const input = join(temp, 'in.mp4');
  const output = join(temp, 'out.mp4');
  try {
    await writeFile(input, data, { mode: 0o600, signal });
    await runFile(ffmpeg, ['-nostdin', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
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
  const services = { photo: 'gpu-qwen-image-21', video: 'pika-h3-flex' };
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
      const file = portraitFile(agent?.metadata?.card?.portrait);
      return configured.has('photo') && configured.has(kind) && !!file && existsSync(new URL(file, assets));
    },
    async generate(kind, { agent, scene, motion, duration, runId, signal }) {
      const portrait = await portraitFor(agent.metadata?.card?.portrait);
      if (!portrait) return { ok: false, error: '当前角色没有可用的设定图' };
      const firstFrame = kind === 'video';
      const ratio = firstFrame ? '9:16' : '3:4';
      if (firstFrame && ![3, 4, 5].includes(duration)) return { ok: false, error: '短片时长须为 3、4 或 5 秒' };
      const photoPrompt = `Vertical ${ratio}. ${selfieFrameLook}\nScene description (setting, subject and ${firstFrame ? 'opening pose' : 'moment'} only): ${scene}`;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(firstFrame ? 420_000 : 180_000)]);
      try {
        const requestId = 'chatlab-' + createHash('sha256').update(runId).digest('hex').slice(0, 40);
        const frame = await mediaBytes(await generatePhoto(await connection(services.photo, deadline),
          { portrait, prompt: photoPrompt, requestId, firstFrame, signal: deadline }), 'photo');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        let data = frame;
        if (firstFrame) {
          const video = await mediaBytes(await generateVideo(await connection(services.video, deadline),
            { frame, prompt: selfieVideoPrompt(motion, duration), duration, requestId, signal: deadline }), 'video');
          data = await capVideoDuration(video, directory, ffmpeg, duration, deadline);
        }
        if (data.length > limits[kind]) throw new Error('Media too large');
        const mediaId = randomBytes(24).toString('hex');
        await writeFile(resolve(directory, mediaId + '.' + kind), data, { mode: 0o600, flag: 'wx' });
        return { ok: true, attachment: { id: mediaId, kind } };
      } catch (error) {
        if (signal.aborted) return { ok: false, error: '本轮已停止' };
        if (deadline.aborted) return { ok: false, error: '生成等待超时' };
        return { ok: false, error: /^Media service HTTP \d{3}$/.test(error?.message)
          ? error.message : '角色影像生成失败' };
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
