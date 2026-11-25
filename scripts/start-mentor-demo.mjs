import { createLabServer } from '../server.mjs';
import { demoAgents, demoChildren } from '../config/mentor-demo.mjs';
import { describeDemoArchitecture } from '../lib/demo-architecture.mjs';
import { readOpenRouterCredential } from '../lib/config.mjs';
import { createToolDecisionClient, TOOL_DECISION_PROVIDERS } from '../lib/tool-trigger.mjs';

const port = Number(process.env.PORT ?? 4385);
const host = '127.0.0.1';
const key = readOpenRouterCredential();
const mentorTrigger = key ? createToolDecisionClient(TOOL_DECISION_PROVIDERS.jev, key, { timeoutMs: 4_000 }) : null;
const lab = createLabServer({
  port, host, storageMode: 'browser', localNoAuth: true, catalogPath: ':memory:',
  publicOrigins: [`http://${host}:${port}`], defaultAgents: demoAgents, defaultChildren: demoChildren,
  mentorTrigger, orchestrateTools: true, describeArchitecture: describeDemoArchitecture,
});
await lab.listen(port, host);
console.log(`导师推荐 Demo 已启动  http://${host}:${port}/`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => lab.close());
