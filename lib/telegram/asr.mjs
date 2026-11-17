import { randomUUID } from 'node:crypto';

export function createVoiceRecognizer(env = process.env, fetchImpl = fetch) {
  const key = env.TELEGRAM_ASR_API_KEY;
  const app = env.TELEGRAM_ASR_APP_KEY, access = env.TELEGRAM_ASR_ACCESS_KEY;
  if (!key && !(app && access)) return null;
  return async audio => {
    if (typeof audio !== 'string' || audio.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) throw new Error('语音数据无效');
    let response, data;
    try {
      response = await fetchImpl('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', {
        method: 'POST', signal: AbortSignal.timeout(60_000), headers: {
          'Content-Type': 'application/json', 'X-Api-Resource-Id': env.TELEGRAM_ASR_RESOURCE_ID || 'volc.bigasr.auc_turbo',
          'X-Api-Request-Id': randomUUID(), 'X-Api-Sequence': '-1',
          ...(key ? { 'X-Api-Key': key } : { 'X-Api-App-Key': app, 'X-Api-Access-Key': access }),
        }, body: JSON.stringify({ user: { uid: 'chatlab-telegram' }, audio: { data: audio },
          request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false } }),
      });
      data = await response.json();
    } catch { throw new Error('语音识别超时或连接失败，请重新发送'); }
    if (!response.ok || response.headers.get('X-Api-Status-Code') !== '20000000' || !data?.result?.text?.trim()) {
      throw new Error('语音没有识别成功，请重新发送或改发文字');
    }
    if (data.result.text.length > 4000) throw new Error('语音转写过长，请分段发送');
    return data.result.text.trim();
  };
}
