import { buildApi } from './index.js';
import { buildProductionRuntime } from './runtime.js';

const apiToken = process.env.PENDLETON_API_TOKEN;
if (apiToken === undefined || apiToken.length < 32) throw new Error('PENDLETON_API_TOKEN_REQUIRED');
const runtime = await buildProductionRuntime();
const app = buildApi(runtime.gateway, { apiToken, readiness: runtime.readiness, logger: true });
const port = Number.parseInt(process.env.PORT ?? '3000', 10);

const shutdown = async (): Promise<void> => {
  await app.close();
  await runtime.close();
};
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
await app.listen({ host: '0.0.0.0', port });
