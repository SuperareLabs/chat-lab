#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { serviceClanConnection } from '../lib/service-clan.mjs';

try {
  const signal = AbortSignal.timeout(1500);
  const token = (await readFile(process.env.CHAT_SERVICE_CLAN_TOKEN_FILE, { encoding: 'utf8', signal })).trim();
  const connection = await serviceClanConnection('server-8-137-116-27', { token, signal });
  const password = connection.api_key;
  if (connection.base_url !== 'ssh://root@8.137.116.27:22' || typeof password !== 'string' || !password || /[\r\n\0]/.test(password)) {
    throw new Error('Unexpected Chengdu SSH connection');
  }
  // OpenSSH reads the password from this helper's private stdout pipe.
  process.stdout.write(`${password}\n`);
} catch {
  process.exitCode = 1;
}
