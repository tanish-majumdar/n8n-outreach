import { Cron } from 'croner';
import type { Container } from './container.ts';
import { logger } from './logger.ts';

export function startScheduler(container: Container): Cron | null {
  const { config, runner } = container;
  if (!config.SCHEDULE_ENABLED) {
    logger.warn('scheduler disabled by SCHEDULE_ENABLED');
    return null;
  }

  const job = new Cron(config.SCHEDULE, { timezone: config.TIMEZONE, protect: true }, async () => {
    try {
      await runner.run({ dry: false, limitOverride: null, trigger: 'schedule' });
    } catch (error) {
      logger.error({ error: String(error) }, 'scheduled run rejected');
    }
  });

  logger.info(
    { cron: config.SCHEDULE, timezone: config.TIMEZONE, next: job.nextRun()?.toISOString() },
    'scheduler started',
  );
  return job;
}
