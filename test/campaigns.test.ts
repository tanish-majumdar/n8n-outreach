import { describe, expect, test } from 'bun:test';
import {
  DuplicateCampaignError,
  buildDedupSet,
  claim,
  emptyDedupSet,
  normalizeDomain,
  parseCampaigns,
  rowToCells,
  stripDomain,
  validateRows,
} from '../src/core/campaigns.ts';
import { LEAD_HEADER, RESEARCH_COLUMNS, type ExtractedRow } from '../src/types.ts';
import { row } from './fakes.ts';

describe('normalizeDomain', () => {
  test('strips protocol, www, path, port and case', () => {
    expect(normalizeDomain('https://WWW.Example.com/path?q=1')).toBe('example.com');
    expect(normalizeDomain('http://example.com:8080')).toBe('example.com');
    expect(normalizeDomain('example.com#frag')).toBe('example.com');
  });

  test('returns empty string for junk', () => {
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain(null)).toBe('');
    expect(normalizeDomain(undefined)).toBe('');
  });
});

describe('parseCampaigns', () => {
  const rows = [
    { campaign_id: 'Matchroom India', active: 'TRUE', research_brief: 'find accelerators', research_daily_limit: '5' },
    { campaign_id: 'Paused One', active: 'FALSE', research_brief: 'x', research_daily_limit: '5' },
    { campaign_id: 'No Brief', active: 'yes', research_brief: '  ', research_daily_limit: '' },
  ];

  test('campaign_id doubles as the tab name and lowercases into the id', () => {
    const [first] = parseCampaigns(rows);
    expect(first!.campaign_id).toBe('matchroom india');
    expect(first!.tab).toBe('Matchroom India');
  });

  test('skips inactive campaigns and flags missing briefs as not ready', () => {
    const parsed = parseCampaigns(rows);
    expect(parsed.map((c) => c.tab)).toEqual(['Matchroom India', 'No Brief']);
    expect(parsed.find((c) => c.tab === 'No Brief')!.research_ready).toBe(false);
  });

  test('falls back to the default limit and caps at 50', () => {
    const parsed = parseCampaigns(
      [
        { campaign_id: 'a', active: '1', research_brief: 'b', research_daily_limit: '' },
        { campaign_id: 'b', active: '1', research_brief: 'b', research_daily_limit: '900' },
      ],
      { defaultLimit: 13 },
    );
    expect(parsed[0]!.research_daily_limit).toBe(13);
    expect(parsed[1]!.research_daily_limit).toBe(50);
  });

  test('throws on a duplicate active campaign_id', () => {
    expect(() =>
      parseCampaigns([
        { campaign_id: 'Dup', active: 'TRUE', research_brief: 'x' },
        { campaign_id: 'dup', active: 'TRUE', research_brief: 'y' },
      ]),
    ).toThrow(DuplicateCampaignError);
  });
});

describe('buildDedupSet', () => {
  test('is global across every tab and tolerates missing tabs', () => {
    const dedup = buildDedupSet([
      { header: [], rows: [{ org_name: 'Alpha', website: 'https://alpha.com/x' }] },
      null,
      { header: [], rows: [{ org_name: 'Beta', website: 'www.beta.io' }] },
    ]);
    expect([...dedup.domains].sort()).toEqual(['alpha.com', 'beta.io']);
    expect(dedup.names.has('alpha')).toBe(true);
  });
});

describe('validateRows', () => {
  const dedup = () => ({ domains: new Set(['taken.com']), names: new Set(['taken org']) });

  test('reports the real reason before applying the limit', () => {
    const raw: ExtractedRow[] = [
      row('', 'https://nameless.com'),
      row('No Site', ''),
      row('Taken Org', 'https://other.com'),
      row('Dup A', 'https://dup.com'),
      row('Dup B', 'https://www.dup.com/page'),
      row('Fine', 'https://fine.com'),
    ];
    const { kept, skipped } = validateRows(raw, { dedup: dedup(), limit: 1 });

    expect(kept.map((r) => r.org_name)).toEqual(['Dup A']);
    expect(skipped.map((s) => s.reason)).toEqual([
      'missing org_name',
      'no official website could be resolved by search',
      'already in a campaign tab (other.com)',
      'duplicate within this batch (dup.com)',
      'over daily limit',
    ]);
  });

  test('a valid row rejected for quota leaves its domain unclaimed', () => {
    const { kept, skipped } = validateRows([row('A', 'https://a.com'), row('B', 'https://b.com')], {
      dedup: emptyDedupSet(),
      limit: 1,
    });
    expect(kept).toHaveLength(1);
    expect(skipped[0]).toEqual({ org_name: 'B', reason: 'over daily limit' });
  });

  test('coerces an unknown tier to T3 and defaults date_confidence', () => {
    const { kept } = validateRows([row('A', 'https://a.com', { tier: 'platinum', date_confidence: '' })], {
      dedup: emptyDedupSet(),
      limit: 5,
    });
    expect(kept[0]!.tier).toBe('T3');
    expect(kept[0]!.date_confidence).toBe('unconfirmed');
  });

  test('keeps a valid tier as written', () => {
    const { kept } = validateRows([row('A', 'https://a.com', { tier: 't1' })], { dedup: emptyDedupSet(), limit: 5 });
    expect(kept[0]!.tier).toBe('T1');
  });

  test('replaces a category outside the allowed list', () => {
    const { kept } = validateRows([row('A', 'https://a.com', { category: 'nonsense' })], {
      dedup: emptyDedupSet(),
      limit: 5,
      allowedCategories: ['accelerators'],
    });
    expect(kept[0]!.category).toBe('accelerators');
  });
});

describe('row shaping', () => {
  test('rowToCells emits exactly the 11 research columns in header order', () => {
    const { kept } = validateRows([row('Alpha', 'https://alpha.com')], { dedup: emptyDedupSet(), limit: 1 });
    const cells = rowToCells(stripDomain(kept[0]!));
    expect(cells).toHaveLength(11);
    expect(RESEARCH_COLUMNS as readonly string[]).toEqual(LEAD_HEADER.slice(0, 11) as string[]);
    expect(cells[0]).toBe('Alpha');
    expect(cells[2]).toBe('https://alpha.com');
  });

  test('research never writes status or any chosen_person column', () => {
    expect(RESEARCH_COLUMNS).not.toContain('status');
    expect(RESEARCH_COLUMNS.filter((c) => c.startsWith('chosen_person'))).toHaveLength(0);
  });

  test('claim adds both the domain and the lowercased name', () => {
    const dedup = emptyDedupSet();
    const { kept } = validateRows([row('Alpha Ltd', 'https://alpha.com')], { dedup: emptyDedupSet(), limit: 1 });
    claim(dedup, kept);
    expect(dedup.domains.has('alpha.com')).toBe(true);
    expect(dedup.names.has('alpha ltd')).toBe(true);
  });
});
