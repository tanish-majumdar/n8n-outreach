import { describe, expect, test } from 'bun:test';
import { hasFailures, runAll, summarize, totalAppended } from '../src/core/pipeline.ts';
import { LEAD_HEADER } from '../src/types.ts';
import { FakeResearch, FakeSheets, hit, row, testConfig, testDeps } from './fakes.ts';

const CONTROL = 'CAMPAIGNS';

function control(rows: Record<string, string>[]) {
  return { [CONTROL]: rows };
}

const alpha = { campaign_id: 'Alpha', active: 'TRUE', research_brief: 'find accelerators', research_daily_limit: '2' };
const beta = { campaign_id: 'Beta', active: 'TRUE', research_brief: 'find networks', research_daily_limit: '2' };

function scripted() {
  return new FakeResearch([
    {
      queries: ['q1'],
      hits: { q1: [hit('https://a.com'), hit('https://b.com')] },
      rows: [row('A', 'https://a.com'), row('B', 'https://b.com')],
    },
  ]);
}

describe('runAll', () => {
  test('creates the missing tab with the full 34-column header and appends 11 cells', async () => {
    const sheets = new FakeSheets(control([alpha]));
    const model = scripted();
    const result = await runAll(testDeps(sheets, model), testConfig(), { dry: false, limitOverride: null });

    expect(sheets.created).toEqual(['Alpha']);
    expect(sheets.tabs.get('Alpha')!.header).toEqual([...LEAD_HEADER]);
    expect(sheets.appended[0]!.tab).toBe('Alpha');
    expect(sheets.appended[0]!.rows[0]).toHaveLength(11);
    expect(result.preflight[0]!.status).toBe('created');
    expect(totalAppended(result)).toBe(2);
  });

  test('a dry run creates nothing, writes nothing and teaches memory nothing', async () => {
    const sheets = new FakeSheets(control([alpha]));
    const deps = testDeps(sheets, scripted());
    const result = await runAll(deps, testConfig(), { dry: true, limitOverride: null });

    expect(sheets.created).toEqual([]);
    expect(sheets.appended).toEqual([]);
    expect(result.preflight[0]!.status).toBe('would create');
    expect(result.campaigns[0]!.rows).toHaveLength(2);
    expect(result.campaigns[0]!.appended).toBe(0);
    expect((await deps.memory.load()).runs).toEqual([]);
  });

  test('a real run records per-query yield into memory', async () => {
    const sheets = new FakeSheets(control([alpha]));
    const deps = testDeps(sheets, scripted());
    await runAll(deps, testConfig(), { dry: false, limitOverride: null });

    const memory = await deps.memory.load();
    expect(memory.runs).toHaveLength(1);
    expect(memory.runs[0]!.campaign_id).toBe('alpha');
    expect(memory.runs[0]!.queries[0]).toEqual({ q: 'q1', hits: 2, fresh: 2, kept: 2 });
  });

  test('dedup is global, so the second campaign cannot re-take the first campaign rows', async () => {
    const sheets = new FakeSheets(control([alpha, beta]));
    const result = await runAll(testDeps(sheets, scripted()), testConfig(), { dry: false, limitOverride: null });

    expect(result.campaigns[0]!.appended).toBe(2);
    expect(result.campaigns[1]!.appended).toBe(0);
    expect(result.campaigns[1]!.trace!.error).toBe('every search hit was already covered');
  });

  test('existing rows in a campaign tab seed the dedup set', async () => {
    const sheets = new FakeSheets({
      ...control([alpha, beta]),
      Beta: [{ org_name: 'A', website: 'https://a.com' }],
    });
    const result = await runAll(testDeps(sheets, scripted()), testConfig(), { dry: false, limitOverride: null });

    expect(result.campaigns[0]!.rows!.map((r) => r.org_name)).toEqual(['B']);
    expect(result.dedup_size).toBeGreaterThan(0);
  });

  test('tabs that are not a campaign_id are ignored entirely', async () => {
    const sheets = new FakeSheets({
      ...control([alpha]),
      Hermes: [{ org_name: 'A', website: 'https://a.com' }],
      MASTER_EVENTS: [{ org_name: 'B', website: 'https://b.com' }],
      Sheet18: [{ org_name: 'C', website: 'https://c.com' }],
    });
    const result = await runAll(testDeps(sheets, scripted()), testConfig(), { dry: false, limitOverride: null });

    expect(result.campaigns[0]!.rows!.map((r) => r.org_name)).toEqual(['A', 'B']);
    expect(result.dedup_size).toBe(2);
  });

  test('a paused campaign still keeps its tab claimed', async () => {
    const paused = { campaign_id: 'Beta', active: 'FALSE', research_brief: 'paused', research_daily_limit: '2' };
    const sheets = new FakeSheets({
      ...control([alpha, paused]),
      Beta: [{ org_name: 'A', website: 'https://a.com' }],
    });
    const result = await runAll(testDeps(sheets, scripted()), testConfig(), { dry: false, limitOverride: null });

    expect(result.campaigns.map((c) => c.campaign_id)).toEqual(['alpha']);
    expect(result.campaigns[0]!.rows!.map((r) => r.org_name)).toEqual(['B']);
  });

  test('limitOverride wins over research_daily_limit', async () => {
    const sheets = new FakeSheets(control([alpha]));
    const result = await runAll(testDeps(sheets, scripted()), testConfig(), { dry: false, limitOverride: 1 });
    expect(result.campaigns[0]!.limit).toBe(1);
    expect(result.campaigns[0]!.appended).toBe(1);
  });

  test('a campaign with no research_brief is reported as not ready and skipped', async () => {
    const sheets = new FakeSheets(control([alpha, { campaign_id: 'Gamma', active: 'TRUE', research_brief: '' }]));
    const result = await runAll(testDeps(sheets, scripted()), testConfig(), { dry: false, limitOverride: null });

    expect(result.not_ready).toEqual(['gamma']);
    expect(result.campaigns.map((c) => c.campaign_id)).toEqual(['alpha']);
  });

  test('one campaign failing does not stop the others', async () => {
    const sheets = new FakeSheets(control([alpha, beta]));
    const model = scripted();
    let calls = 0;
    const original = model.generateQueries.bind(model);
    model.generateQueries = async (req) => {
      calls += 1;
      if (calls === 1) throw new Error('workers ai exploded');
      return original(req);
    };

    const result = await runAll(testDeps(sheets, model), testConfig(), { dry: false, limitOverride: null });

    expect(result.campaigns[0]!.error).toBe('workers ai exploded');
    expect(result.campaigns[1]!.appended).toBe(2);
    expect(hasFailures(result)).toBe(true);
  });

  test('a duplicate active campaign_id aborts before anything is written', async () => {
    const sheets = new FakeSheets(control([alpha, { ...alpha, campaign_id: 'alpha' }]));
    await expect(runAll(testDeps(sheets, scripted()), testConfig(), { dry: false, limitOverride: null })).rejects.toThrow(
      /Duplicate active campaign_id: alpha/,
    );
    expect(sheets.appended).toEqual([]);
  });

  test('a missing CAMPAIGNS tab fails loudly', async () => {
    const sheets = new FakeSheets({});
    await expect(runAll(testDeps(sheets, scripted()), testConfig(), { dry: false, limitOverride: null })).rejects.toThrow(
      /CAMPAIGNS tab not found/,
    );
  });
});

describe('search angles', () => {
  test('are derived from the campaign brief, not a global list', async () => {
    const sheets = new FakeSheets(control([alpha]));
    const model = scripted();
    model.angles = ['applied AI engineering buyers', 'mid-market fintech in India'];
    await runAll(testDeps(sheets, model), testConfig(), { dry: false, limitOverride: null });

    expect(model.angleBriefs).toEqual(['find accelerators']);
    expect(model.angles).toContain(model.queryPrompts[0]!.angle);
  });

  test('are cached across runs while the brief is unchanged', async () => {
    const sheets = new FakeSheets(control([alpha]));
    const deps = testDeps(sheets, scripted());
    await runAll(deps, testConfig(), { dry: false, limitOverride: null });
    const memory = await deps.memory.load();
    expect(Object.keys(memory.angles ?? {})).toEqual(['alpha']);

    const second = scripted();
    await runAll({ ...deps, model: second, search: second }, testConfig(), { dry: false, limitOverride: null });
    expect(second.angleBriefs).toEqual([]);
  });

  test('a changed brief invalidates the cache and re-derives', async () => {
    const sheets = new FakeSheets(control([alpha]));
    const deps = testDeps(sheets, scripted());
    await runAll(deps, testConfig(), { dry: false, limitOverride: null });

    sheets.tabs.set(CONTROL, { header: [], rows: [{ ...alpha, research_brief: 'find something completely different' }] });
    const second = scripted();
    await runAll({ ...deps, model: second, search: second }, testConfig(), { dry: false, limitOverride: null });
    expect(second.angleBriefs).toEqual(['find something completely different']);
  });

  test('a campaign whose angles cannot be derived fails loudly instead of searching off-brief', async () => {
    const sheets = new FakeSheets(control([alpha]));
    const model = scripted();
    model.angles = [];
    const result = await runAll(testDeps(sheets, model), testConfig(), { dry: false, limitOverride: null });

    expect(result.campaigns[0]!.error).toMatch(/No search angles could be derived/);
    expect(result.campaigns[0]!.appended).toBe(0);
    expect(model.queryPrompts).toHaveLength(0);
    expect(sheets.appended).toEqual([]);
  });
});

describe('summarize', () => {
  test('reports appended counts, skips and created tabs', async () => {
    const sheets = new FakeSheets(control([alpha]));
    const result = await runAll(testDeps(sheets, scripted()), testConfig(), { dry: false, limitOverride: null });
    const text = summarize(result);

    expect(text).toContain('alpha: 2 appended');
    expect(text).toContain('tabs created: Alpha');
    expect(text).not.toContain('dry run');
  });

  test('a dry run says would append, not appended', async () => {
    const sheets = new FakeSheets(control([alpha]));
    const result = await runAll(testDeps(sheets, scripted()), testConfig(), { dry: true, limitOverride: null });
    expect(summarize(result)).toContain('(dry run)');
    expect(summarize(result)).toContain('alpha: 2 would append');
  });

  test('a failed campaign is called out', async () => {
    const result = {
      started: 'x', finished: 'y', dry: false, spreadsheet: 's', preflight: [], not_ready: [], dedup_size: 0,
      campaigns: [{ campaign_id: 'alpha', tab: 'Alpha', limit: 2, appended: 0, error: 'boom' }],
    };
    expect(summarize(result)).toContain('alpha: FAILED - boom');
  });
});
