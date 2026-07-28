import { describe, expect, test } from 'bun:test';
import { NoAnglesError, buildFeedback, pickAngle, researchCampaign } from '../src/core/research.ts';
import { emptyDedupSet } from '../src/core/campaigns.ts';
import { FakeResearch, hit, row } from './fakes.ts';
import type { Campaign, DedupSet } from '../src/types.ts';

const campaign: Campaign = {
  campaign_id: 'alpha',
  tab: 'Alpha',
  research_brief: 'find accelerators',
  research_daily_limit: 5,
  research_ready: true,
};

function options(overrides: Partial<Parameters<typeof researchCampaign>[2]> = {}) {
  return {
    limit: 2,
    dedup: emptyDedupSet(),
    queriesPerRound: 1,
    maxRounds: 3,
    dayIndex: 0,
    location: 'IN',
    memoryPrompt: '',
    verify: false,
    angles: ['angle one', 'angle two', 'angle three'],
    ...overrides,
  };
}

describe('pickAngle', () => {
  const angles = ['a', 'b', 'c'];

  test('rotates through the campaign angle list and wraps in both directions', () => {
    expect(pickAngle(0, angles)).toBe('a');
    expect(pickAngle(3, angles)).toBe('a');
    expect(pickAngle(-1, angles)).toBe('c');
  });
});

describe('researchCampaign without angles', () => {
  test('refuses to run rather than searching off-brief', async () => {
    const model = new FakeResearch([{ queries: ['q1'], hits: {}, rows: [] }]);
    await expect(
      researchCampaign({ model, search: model }, campaign, options({ angles: [] })),
    ).rejects.toThrow(NoAnglesError);
    expect(model.queryPrompts).toHaveLength(0);
  });
});

describe('buildFeedback', () => {
  test('names what was tried, what is covered, and how many are still needed', () => {
    const text = buildFeedback({ tried: ['q one', 'q two'], covered: ['Alpha Org'], need: 4, round: 2 });
    expect(text).toContain('Round 2');
    expect(text).toContain('you still need 4 more organisations'.replace('you', 'You'));
    expect(text).toContain('q one');
    expect(text).toContain('Alpha Org');
    expect(text).toContain('do not repeat or reword');
  });

  test('caps the covered list so the prompt cannot run away', () => {
    const covered = Array.from({ length: 100 }, (_, i) => `Org ${i}`);
    const text = buildFeedback({ tried: [], covered, need: 1, round: 2 });
    expect(text).toContain('Org 39');
    expect(text).not.toContain('Org 40');
  });
});

describe('verification against the organisation page', () => {
  const twoRows = () => new FakeResearch([
    { queries: ['q1'], hits: { q1: [hit('https://a.com'), hit('https://b.com')] }, rows: [row('A', 'https://a.com'), row('B', 'https://b.com')] },
  ]);

  const verdict = (org: string, over: Partial<import('../src/types.ts').VerifiedRow> = {}) => ({
    org_name: org, matches_brief: true, reason: 'looks right', category: 'angle one',
    event_type: '', tier: '', region: '', dates_raw: '', date_confidence: '', attendance: '', event_goal: '', ...over,
  });

  test('drops a candidate whose own page contradicts the brief', async () => {
    const model = twoRows();
    model.verdicts = [verdict('A'), verdict('B', { matches_brief: false, reason: 'this is a news publisher' })];
    const { kept, skipped } = await researchCampaign({ model, search: model }, campaign, options({ verify: true, limit: 2, maxRounds: 1 }));

    expect(kept.map((r) => r.org_name)).toEqual(['A']);
    expect(skipped.find((s) => s.org_name === 'B')!.reason).toContain('this is a news publisher');
  });

  test('keeps a category the model invented rather than rejecting the row', async () => {
    const model = twoRows();
    model.verdicts = [verdict('A', { category: 'regtech vendors' }), verdict('B')];
    const { kept } = await researchCampaign({ model, search: model }, campaign, options({ verify: true, limit: 2, maxRounds: 1 }));

    expect(kept.map((r) => r.org_name)).toEqual(['A', 'B']);
    expect(kept.find((r) => r.org_name === 'A')!.category).toBe('regtech vendors');
  });

  test('falls back to the searched category when the model returns a blank one', async () => {
    const model = twoRows();
    model.verdicts = [verdict('A', { category: '   ' }), verdict('B')];
    const { kept } = await researchCampaign({ model, search: model }, campaign, options({ verify: true, limit: 2, maxRounds: 1 }));
    expect(kept.find((r) => r.org_name === 'A')!.category).toBe('');
  });

  test('relabels the category to the one the page actually supports', async () => {
    const model = twoRows();
    model.verdicts = [verdict('A', { category: 'angle two' }), verdict('B')];
    const { kept } = await researchCampaign({ model, search: model }, campaign, options({ verify: true, limit: 2, maxRounds: 1 }));
    expect(kept.find((r) => r.org_name === 'A')!.category).toBe('angle two');
  });

  test('fills the empty fields from the page and honours a corrected tier', async () => {
    const model = twoRows();
    model.verdicts = [verdict('A', { tier: 'T1', attendance: '4,000 members', region: 'APAC', event_type: 'network' }), verdict('B')];
    const { kept } = await researchCampaign({ model, search: model }, campaign, options({ verify: true, limit: 2, maxRounds: 1 }));
    const a = kept.find((r) => r.org_name === 'A')!;
    expect(a.tier).toBe('T1');
    expect(a.attendance).toBe('4,000 members');
    expect(a.region).toBe('APAC');
  });

  test('drops a candidate whose page could not be fetched', async () => {
    const model = twoRows();
    model.pages = new Map([['https://a.com', 'real page text']]);
    model.verdicts = [verdict('A'), verdict('B')];
    const { kept, skipped } = await researchCampaign({ model, search: model }, campaign, options({ verify: true, limit: 2, maxRounds: 1 }));

    expect(kept.map((r) => r.org_name)).toEqual(['A']);
    expect(skipped.find((s) => s.org_name === 'B')!.reason).toContain('could not be fetched');
  });

  test('a round emptied by verification triggers another round', async () => {
    const model = new FakeResearch([
      { queries: ['q1'], hits: { q1: [hit('https://a.com')] }, rows: [row('A', 'https://a.com')] },
      { queries: ['q2'], hits: { q2: [hit('https://b.com')] }, rows: [row('B', 'https://b.com')] },
    ]);
    model.verdicts = null;
    let call = 0;
    const original = model.verifyRows.bind(model);
    model.verifyRows = async (req) => {
      call += 1;
      const out = await original(req);
      return call === 1 ? out.map((v) => ({ ...v, matches_brief: false, reason: 'not a fit' })) : out;
    };

    const { kept, trace } = await researchCampaign({ model, search: model }, campaign, options({ verify: true, limit: 1 }));
    expect(trace.rounds_used).toBe(2);
    expect(kept.map((r) => r.org_name)).toEqual(['B']);
    expect(trace.rounds[0]!.rejected_by_verification).toBe(1);
  });
});

describe('researchCampaign', () => {
  test('a satisfied first round does not run a second', async () => {
    const model = new FakeResearch([
      { queries: ['q1'], hits: { q1: [hit('https://a.com'), hit('https://b.com')] }, rows: [row('A', 'https://a.com'), row('B', 'https://b.com')] },
    ]);
    const { kept, trace } = await researchCampaign({ model, search: model }, campaign, options());

    expect(kept.map((r) => r.org_name)).toEqual(['A', 'B']);
    expect(trace.rounds_used).toBe(1);
    expect(model.queryPrompts).toHaveLength(1);
  });

  test('a short round feeds tried queries and covered orgs into the next prompt', async () => {
    const model = new FakeResearch([
      { queries: ['q1'], hits: { q1: [hit('https://a.com')] }, rows: [row('A', 'https://a.com')] },
      { queries: ['q2'], hits: { q2: [hit('https://b.com')] }, rows: [row('B', 'https://b.com')] },
    ]);
    const { kept, trace } = await researchCampaign({ model, search: model }, campaign, options());

    expect(kept.map((r) => r.org_name)).toEqual(['A', 'B']);
    expect(trace.rounds_used).toBe(2);

    const second = model.queryPrompts[1]!;
    expect(second.feedback).toContain('q1');
    expect(second.feedback).toContain('You still need 1 more');
    expect(second.angle).not.toBe(model.queryPrompts[0]!.angle);
  });

  test('memory only primes the opening round', async () => {
    const model = new FakeResearch([
      { queries: ['q1'], hits: { q1: [hit('https://a.com')] }, rows: [row('A', 'https://a.com')] },
      { queries: ['q2'], hits: { q2: [hit('https://b.com')] }, rows: [row('B', 'https://b.com')] },
    ]);
    await researchCampaign({ model, search: model }, campaign, options({ memoryPrompt: 'REMEMBERED' }));

    expect(model.queryPrompts[0]!.memoryPrompt).toBe('REMEMBERED');
    expect(model.queryPrompts[1]!.memoryPrompt).toBe('');
  });

  test('hits already in the sheet are dropped before the extractor is paid for', async () => {
    const dedup: DedupSet = { domains: new Set(['a.com']), names: new Set() };
    const model = new FakeResearch([
      { queries: ['q1'], hits: { q1: [hit('https://a.com', 'Alpha Org')] }, rows: [] },
      { queries: ['q2'], hits: { q2: [hit('https://a.com', 'Alpha Org')] }, rows: [] },
    ]);
    const { kept, trace } = await researchCampaign({ model, search: model }, campaign, options({ dedup }));

    expect(kept).toHaveLength(0);
    expect(model.extractPrompts).toHaveLength(0);
    expect(trace.rounds.every((r) => r.note === 'every hit was already covered')).toBe(true);
    expect(trace.error).toBe('every search hit was already covered');
  });

  test('stops after two consecutive dry rounds instead of burning maxRounds', async () => {
    const dedup: DedupSet = { domains: new Set(['a.com']), names: new Set() };
    const model = new FakeResearch([{ queries: ['q1'], hits: { q1: [hit('https://a.com')] }, rows: [] }]);
    const { trace } = await researchCampaign({ model, search: model }, campaign, options({ dedup, maxRounds: 9 }));
    expect(trace.rounds_used).toBe(2);
  });

  test('round two cannot re-add what round one already claimed', async () => {
    const model = new FakeResearch([
      { queries: ['q1'], hits: { q1: [hit('https://a.com')] }, rows: [row('A', 'https://a.com')] },
      { queries: ['q2'], hits: { q2: [hit('https://c.com')] }, rows: [row('A again', 'https://a.com'), row('C', 'https://c.com')] },
    ]);
    const { kept, skipped } = await researchCampaign({ model, search: model }, campaign, options());

    expect(kept.map((r) => r.org_name)).toEqual(['A', 'C']);
    expect(skipped.some((s) => s.reason.includes('already in a campaign tab'))).toBe(true);
  });

  test('a round with no queries aborts with an explanatory trace', async () => {
    const model = new FakeResearch([{ queries: [], hits: {}, rows: [] }]);
    const { kept, trace } = await researchCampaign({ model, search: model }, campaign, options());
    expect(kept).toHaveLength(0);
    expect(trace.rounds[0]!.error).toBe('model returned no search queries');
  });

  test('credits the query that surfaced each kept row', async () => {
    const model = new FakeResearch([
      {
        queries: ['q1'],
        hits: { q1: [hit('https://a.com'), hit('https://b.com')] },
        rows: [row('A', 'https://a.com'), row('B', 'https://b.com')],
      },
    ]);
    const { trace } = await researchCampaign({ model, search: model }, campaign, options());
    expect(trace.query_yield).toEqual([{ q: 'q1', hits: 2, fresh: 2, kept: 2 }]);
  });

  test('search errors surface in the round log without killing the round', async () => {
    const model = new FakeResearch([
      { queries: ['q1'], hits: { q1: [hit('https://a.com')] }, rows: [row('A', 'https://a.com')] },
    ]);
    model.search = async (query: string) => ({ query, results: [hit('https://a.com')], error: 'search HTTP 429' });
    const { trace } = await researchCampaign({ model, search: model }, campaign, options({ limit: 1 }));
    expect(trace.rounds[0]!.search_errors).toEqual(['search HTTP 429']);
  });

  test('page fetching batches in tens and verification merges by org_name', async () => {
    const rows = Array.from({ length: 13 }, (_, i) => row(`Org${i}`, `https://o${i}.com`));
    const model = new FakeResearch([{ queries: ['q1'], hits: { q1: rows.map((r) => hit(r.website)) }, rows }]);
    model.verdicts = rows.map((r) => ({
      org_name: r.org_name,
      matches_brief: true,
      reason: 'fits',
      category: 'angle one',
      event_type: r.org_name === 'Org0' ? 'network' : '',
      tier: r.org_name === 'Org0' ? 'T1' : '',
      region: '', dates_raw: '', date_confidence: '',
      attendance: r.org_name === 'Org0' ? '4,000' : '',
      event_goal: '',
    }));

    const { kept } = await researchCampaign({ model, search: model }, campaign, options({ limit: 13, verify: true, maxRounds: 1 }));

    expect(model.fetchBatches).toEqual([10, 3]);
    expect(kept).toHaveLength(13);
    expect(kept.find((r) => r.org_name === 'Org0')!.tier).toBe('T1');
    expect(kept.find((r) => r.org_name === 'Org0')!.attendance).toBe('4,000');
    expect(kept.find((r) => r.org_name === 'Org1')!.tier).toBe('T2');
  });

  test('verification never downgrades a tier to an invalid value', async () => {
    const model = new FakeResearch([
      { queries: ['q1'], hits: { q1: [hit('https://a.com')] }, rows: [row('A', 'https://a.com', { tier: 'T1' })] },
    ]);
    model.verdicts = [{
      org_name: 'A', matches_brief: true, reason: 'fits', category: 'angle one',
      event_type: '', tier: 'gold', region: '', dates_raw: '', date_confidence: '', attendance: '', event_goal: '',
    }];
    const { kept } = await researchCampaign({ model, search: model }, campaign, options({ limit: 1, verify: true, maxRounds: 1 }));
    expect(kept[0]!.tier).toBe('T1');
  });
});
