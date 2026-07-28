import { ConfigError, loadConfig } from './config.ts';
import { createContainer } from './container.ts';
import { logger } from './logger.ts';
import { startScheduler } from './scheduler.ts';
import { createApp } from './server/app.ts';

function boot() {
  try {
    return createContainer(loadConfig());
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.fatal({ issues: error.issues }, 'refusing to start');
    } else {
      logger.fatal({ error: String(error) }, 'refusing to start');
    }
    process.exit(1);
  }
}

const container = boot();
const job = startScheduler(container);
const server = Bun.serve({
  port: container.config.PORT,
  hostname: container.config.HOST,
  fetch: createApp(container).fetch,
  idleTimeout: 255,
});

if (!container.config.ADMIN_TOKEN) {
  logger.warn('ADMIN_TOKEN is unset - every request is trusted, so keep HOST bound to localhost');
}
logger.info({ url: `http://${server.hostname}:${server.port}` }, 'listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    job?.stop();
    void server.stop(false).then(() => process.exit(0));
  });
}
