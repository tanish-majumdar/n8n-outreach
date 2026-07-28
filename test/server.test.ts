import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { createRunStore } from '../src/store/run-store.ts';
import { createRunner } from '../src/runner.ts';
import type { Container } from '../src/container.ts';
import { FakeResearch, FakeSheets, hit, row, testConfig, testDeps } from './fakes.ts';
import type { Config } from '../src/config.ts';

const alpha = { campaign_id: 'Alpha', active: 'TRUE', research_brief: 'find accelerators', research_daily_limit: '2' };

async function harness(overrides: Partial<Config> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'cr-server-'));
  const sheets = new FakeSheets({ CAMPAIGNS: [alpha] });
  const model = new FakeResearch([
    { queries: ['q1'], hits: { q1: [hit('https://a.com'), hit('https://b.com')] }, rows: [row('A', 'https://a.com'), row('B', 'https://b.com')] },
  ]);
  const config = testConfig({ STATE_DIR: stateDir, ...overrides });
  const deps = testDeps(sheets, model);
  const runs = createRunStore(stateDir);
  const container: Container = { config, deps, runs, runner: createRunner(deps, config, runs, () => 0.5) };
  return { app: createApp(container), container, sheets, deps };
}

const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;

describe('GET /health', () => {
  test('is public even when a token is configured', async () => {
    const { app } = await harness({ ADMIN_TOKEN: 'secret' });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
  });
});

describe('authentication', () => {
  test('rejects a missing or wrong bearer token', async () => {
    const { app } = await harness({ ADMIN_TOKEN: 'secret' });
    expect((await app.request('/api/status')).status).toBe(401);
    expect((await app.request('/api/status', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });

  test('accepts the configured token', async () => {
    const { app } = await harness({ ADMIN_TOKEN: 'secret' });
    const res = await app.request('/api/status', { headers: { authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
  });

  test('is open when no token is configured', async () => {
    const { app } = await harness();
    expect((await app.request('/api/status')).status).toBe(200);
  });
});

describe('POST /api/runs', () => {
  test('waits for the run and reports what was appended', async () => {
    const { app, sheets } = await harness();
    const res = await app.request('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ dry: false, wait: true }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe('ok');
    expect(body.appended).toBe(2);
    expect(sheets.appended[0]!.tab).toBe('Alpha');
  });

  test('a dry run writes nothing', async () => {
    const { app, sheets } = await harness();
    await app.request('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ dry: true, wait: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(sheets.appended).toEqual([]);
  });

  test('returns 202 and a run id when not waiting', async () => {
    const { app } = await harness();
    const res = await app.request('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ dry: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ status: 'running' });
  });

  test('rejects a limit outside the allowed range', async () => {
    const { app } = await harness();
    const res = await app.request('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ limit: 500 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  test('a second concurrent run is refused with 409', async () => {
    const { app, container } = await harness();
    const first = container.runner.run({ dry: true, limitOverride: null, trigger: 'manual' });
    const res = await app.request('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ dry: true, wait: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(409);
    await first;
  });
});

describe('run history', () => {
  test('lists runs without their full trace, and serves the trace by id', async () => {
    const { app } = await harness();
    await app.request('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ dry: false, wait: true }),
      headers: { 'content-type': 'application/json' },
    });

    const list = (await json(await app.request('/api/runs'))) as { runs: { id: string; result?: unknown }[] };
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]!.result).toBeUndefined();

    const detail = await json(await app.request(`/api/runs/${list.runs[0]!.id}`));
    expect((detail.result as { campaigns: unknown[] }).campaigns).toHaveLength(1);
  });

  test('an unknown run id is a 404, and a traversal attempt is not a file read', async () => {
    const { app } = await harness();
    expect((await app.request('/api/runs/nope')).status).toBe(404);
    expect((await app.request('/api/runs/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
  });

  test('status reflects the most recent run', async () => {
    const { app } = await harness();
    await app.request('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ dry: false, wait: true }),
      headers: { 'content-type': 'application/json' },
    });
    const status = (await json(await app.request('/api/status'))) as { last: { status: string; appended: number } };
    expect(status.last.status).toBe('ok');
    expect(status.last.appended).toBe(2);
  });
});

describe('GET /api/campaigns', () => {
  test('reports each campaign and whether its tab exists yet', async () => {
    const { app } = await harness();
    const body = (await json(await app.request('/api/campaigns'))) as {
      campaigns: { campaign_id: string; tab: string; tab_exists: boolean }[];
    };
    expect(body.campaigns).toEqual([
      expect.objectContaining({ campaign_id: 'alpha', tab: 'Alpha', tab_exists: false, research_ready: true }),
    ]);
  });
});

describe('GET /api/memory', () => {
  test('is empty before any run and populated after one', async () => {
    const { app } = await harness();
    expect((await json(await app.request('/api/memory'))).runs_recorded).toBe(0);

    await app.request('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ dry: false, wait: true }),
      headers: { 'content-type': 'application/json' },
    });

    const body = (await json(await app.request('/api/memory'))) as {
      runs_recorded: number;
      campaigns: { campaign_id: string; productive: { q: string }[] }[];
    };
    expect(body.runs_recorded).toBe(1);
    expect(body.campaigns[0]!.productive[0]!.q).toBe('q1');
  });
});

describe('dashboard', () => {
  test('is served as HTML at the root', async () => {
    const { app } = await harness();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('campaign research');
  });

  test('never embeds the admin token in the page', async () => {
    const { app } = await harness({ ADMIN_TOKEN: 'super-secret-value' });
    expect(await (await app.request('/')).text()).not.toContain('super-secret-value');
  });
});

describe('unknown routes', () => {
  test('return a JSON 404', async () => {
    const { app } = await harness();
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe('not found');
  });
});
