import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger as httpLogger } from 'hono/logger';
import { z } from 'zod';
import type { Container } from '../container.ts';
import { logger } from '../logger.ts';
import { memoryDigest } from '../core/memory.ts';
import { parseCampaigns } from '../core/campaigns.ts';
import { RunInProgressError } from '../runner.ts';
import { dashboard } from './dashboard.ts';

const triggerSchema = z.object({
  dry: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).nullable().default(null),
  wait: z.boolean().default(false),
});

function requireAuth(container: Container) {
  return async (c: { req: { header: (n: string) => string | undefined } }, next: () => Promise<void>) => {
    const token = container.config.ADMIN_TOKEN;
    if (!token) return next();
    const header = c.req.header('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (provided !== token) throw new HTTPException(401, { message: 'invalid or missing bearer token' });
    return next();
  };
}

export function createApp(container: Container): Hono {
  const app = new Hono();
  const auth = requireAuth(container);

  app.use('*', httpLogger((message, ...rest) => logger.debug({ rest }, message)));

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof RunInProgressError) return c.json({ error: error.message, runId: error.runId }, 409);
    logger.error({ error: String(error) }, 'request failed');
    return c.json({ error: error instanceof Error ? error.message : 'internal error' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true, service: 'campaign-research', now: new Date().toISOString() }));

  app.get('/', (c) => c.html(dashboard(container.config)));

  app.get('/api/status', auth, async (c) => {
    const [latest, running] = [await container.runs.latest(), container.runner.current()];
    return c.json({
      running: running ? { id: running.id, startedAt: running.startedAt, trigger: running.trigger } : null,
      schedule: container.config.SCHEDULE_ENABLED
        ? { cron: container.config.SCHEDULE, timezone: container.config.TIMEZONE }
        : null,
      spreadsheet: container.config.MASTER_EVENTS_ID,
      model: container.config.CF_MODEL,
      last: latest
        ? {
            id: latest.id,
            status: latest.status,
            dry: latest.dry,
            trigger: latest.trigger,
            startedAt: latest.startedAt,
            finishedAt: latest.finishedAt,
            durationMs: latest.durationMs,
            appended: latest.appended,
            summary: latest.summary,
            error: latest.error,
          }
        : null,
    });
  });

  app.get('/api/runs', auth, async (c) => c.json({ runs: await container.runs.list() }));

  app.get('/api/runs/:id', auth, async (c) => {
    const record = await container.runs.get(c.req.param('id'));
    if (!record) throw new HTTPException(404, { message: 'run not found' });
    return c.json(record);
  });

  app.post('/api/runs', auth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = triggerSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const options = { dry: parsed.data.dry, limitOverride: parsed.data.limit, trigger: 'manual' as const };

    if (parsed.data.wait) return c.json(await container.runner.run(options));
    const record = await container.runner.start(options);
    return c.json({ id: record.id, status: record.status, startedAt: record.startedAt }, 202);
  });

  app.get('/api/campaigns', auth, async (c) => {
    const tab = await container.deps.sheets.readTab(container.config.CAMPAIGNS_TAB);
    if (!tab) throw new HTTPException(404, { message: `${container.config.CAMPAIGNS_TAB} tab not found` });
    const campaigns = parseCampaigns(tab.rows, { defaultLimit: container.config.DEFAULT_DAILY_LIMIT });
    const tabs = await container.deps.sheets.listTabs();
    return c.json({
      campaigns: campaigns.map((campaign) => ({ ...campaign, tab_exists: tabs.includes(campaign.tab) })),
    });
  });

  app.get('/api/memory', auth, async (c) => {
    const memory = await container.deps.memory.load();
    const ids = [...new Set(memory.runs.map((r) => r.campaign_id))];
    return c.json({
      runs_recorded: memory.runs.length,
      campaigns: ids.map((id) => ({ campaign_id: id, ...memoryDigest(memory, id) })),
    });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  return app;
}
