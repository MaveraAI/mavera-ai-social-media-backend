// Starts the API server (Railway sets PORT).
import { serve } from '@hono/node-server';
import { app } from '@/app';
import { port } from '@/config';
import { ensureConnected, getMongo } from '@/lib/db/mongo.server';

const server = serve({ fetch: app.fetch, port: port(), hostname: '0.0.0.0' }, (info) => {
  console.info(`[api] Mavera AI API listening on port ${info.port}`);
});

// Connect early so the first request is fast; failures retry on the next request.
ensureConnected().then(
  () => console.info('[api] Connected to MongoDB'),
  () => console.error('[api] MongoDB not reachable yet; will retry on the next request'),
);

function shutdown(signal: string) {
  console.info(`[api] ${signal} received, shutting down`);
  server.close(() => {
    getMongo().client.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
