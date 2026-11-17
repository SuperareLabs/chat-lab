import { TelegramApp } from './lib/telegram/app.mjs';

process.umask(0o077);
const app = new TelegramApp();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (stopping) return; stopping = true;
  await app.stop();
});
try {
  const identity = await app.initialize();
  console.log(JSON.stringify({ event: 'telegram_ready', username: identity.username,
    allowedUsers: app.allowed.length, thinking: 'disabled' }));
  await app.run();
} catch {
  console.error('Telegram 启动失败；请检查私有配置、网络、Webhook或工作区版本。未输出凭据。');
  await app.stop(); process.exitCode = 1;
}
