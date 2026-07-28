import type { Config } from '../config.ts';
import { logger } from '../logger.ts';
import type { Notifier } from '../types.ts';

export function createNotifier(config: Config, fetchImpl: typeof fetch = fetch): Notifier {
  return {
    async send(text: string): Promise<void> {
      if (!config.SLACK_WEBHOOK) return;
      try {
        await fetchImpl(config.SLACK_WEBHOOK, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
      } catch (error) {
        logger.warn({ error: String(error) }, 'slack notification failed');
      }
    },
  };
}

export const silentNotifier: Notifier = {
  async send(): Promise<void> {},
};
