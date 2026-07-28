import {
  RESEARCH_COLUMNS,
  TIERS,
  type Campaign,
  type DedupSet,
  type ExtractedRow,
  type LeadRow,
  type SheetTab,
  type SkippedRow,
  type Tier,
  type ValidatedRow,
  type VerifiedRow,
} from '../types.ts';

const TRUTHY = new Set(['true', 'yes', '1']);

export function normalizeDomain(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0]!
    .split(':')[0]!
    .trim()
    .toLowerCase();
}

export class DuplicateCampaignError extends Error {
  constructor(id: string) {
    super(`Duplicate active campaign_id: ${id}`);
    this.name = 'DuplicateCampaignError';
  }
}

export function parseCampaigns(
  rows: Record<string, string>[],
  { defaultLimit = 13 }: { defaultLimit?: number } = {},
): Campaign[] {
  const seen = new Set<string>();
  const campaigns: Campaign[] = [];

  for (const row of rows ?? []) {
    const tab = String(row.campaign_id ?? '').trim();
    const id = tab.toLowerCase();
    if (!tab) continue;
    if (!TRUTHY.has(String(row.active ?? '').trim().toLowerCase())) continue;
    if (seen.has(id)) throw new DuplicateCampaignError(id);
    seen.add(id);

    const brief = String(row.research_brief ?? '').trim();
    const limit = Number.parseInt(String(row.research_daily_limit ?? ''), 10);
    campaigns.push({
      campaign_id: id,
      tab,
      research_brief: brief,
      research_daily_limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : defaultLimit,
      research_ready: brief.length > 0,
    });
  }
  return campaigns;
}

export function campaignTabNames(rows: Record<string, string>[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of rows ?? []) {
    const tab = String(row.campaign_id ?? '').trim();
    if (!tab || seen.has(tab.toLowerCase())) continue;
    seen.add(tab.toLowerCase());
    names.push(tab);
  }
  return names;
}

export function buildDedupSet(tabs: (SheetTab | null)[]): DedupSet {
  const domains = new Set<string>();
  const names = new Set<string>();
  for (const tab of tabs) {
    for (const row of tab?.rows ?? []) {
      const domain = normalizeDomain(row.website ?? row.domain);
      if (domain) domains.add(domain);
      const name = String(row.org_name ?? '').trim().toLowerCase();
      if (name) names.add(name);
    }
  }
  return { domains, names };
}

export function emptyDedupSet(): DedupSet {
  return { domains: new Set(), names: new Set() };
}

function coerceTier(value: string): Tier {
  const upper = value.trim().toUpperCase();
  return (TIERS as readonly string[]).includes(upper) ? (upper as Tier) : 'T3';
}

export interface ValidateOptions {
  dedup: DedupSet;
  limit: number;
  allowedCategories?: string[];
}

export function validateRows(
  raw: ExtractedRow[] | undefined,
  { dedup, limit, allowedCategories = [] }: ValidateOptions,
): { kept: ValidatedRow[]; skipped: SkippedRow[] } {
  const kept: ValidatedRow[] = [];
  const skipped: SkippedRow[] = [];
  const batchDomains = new Set<string>();

  for (const item of raw ?? []) {
    const org = String(item?.org_name ?? '').trim();
    const domain = normalizeDomain(item?.website);

    if (!org) {
      skipped.push({ org_name: '(unnamed)', reason: 'missing org_name' });
      continue;
    }
    if (!domain) {
      skipped.push({ org_name: org, reason: 'no official website could be resolved by search' });
      continue;
    }
    if (dedup.domains.has(domain) || dedup.names.has(org.toLowerCase())) {
      skipped.push({ org_name: org, reason: `already in a campaign tab (${domain})` });
      continue;
    }
    if (batchDomains.has(domain)) {
      skipped.push({ org_name: org, reason: `duplicate within this batch (${domain})` });
      continue;
    }
    if (kept.length >= limit) {
      skipped.push({ org_name: org, reason: 'over daily limit' });
      continue;
    }

    const category = String(item?.category ?? '').trim();
    batchDomains.add(domain);
    kept.push({
      org_name: org,
      event_name: String(item?.event_name ?? '').trim(),
      website: String(item?.website ?? '').trim(),
      event_type: String(item?.event_type ?? '').trim(),
      tier: coerceTier(String(item?.tier ?? '')),
      region: String(item?.region ?? '').trim(),
      dates_raw: String(item?.dates_raw ?? '').trim(),
      date_confidence: String(item?.date_confidence || 'unconfirmed').trim(),
      attendance: String(item?.attendance ?? '').trim(),
      event_goal: String(item?.event_goal ?? '').trim(),
      category:
        allowedCategories.length && !allowedCategories.includes(category) ? allowedCategories[0]! : category,
      domain,
    });
  }
  return { kept, skipped };
}

const VERIFIABLE_FIELDS = [
  'event_type',
  'region',
  'dates_raw',
  'date_confidence',
  'attendance',
  'event_goal',
] as const;

export function applyVerification(
  rows: ValidatedRow[],
  verdicts: VerifiedRow[],
  { pages }: { pages: Map<string, string> },
): { kept: ValidatedRow[]; skipped: SkippedRow[] } {
  const byName = new Map(verdicts.map((v) => [v.org_name.trim().toLowerCase(), v]));
  const kept: ValidatedRow[] = [];
  const skipped: SkippedRow[] = [];

  for (const row of rows) {
    if (!pages.has(row.website)) {
      skipped.push({ org_name: row.org_name, reason: 'unverified: its website could not be fetched' });
      continue;
    }

    const verdict = byName.get(row.org_name.toLowerCase());
    if (!verdict) {
      skipped.push({ org_name: row.org_name, reason: 'unverified: the model returned no verdict for it' });
      continue;
    }
    if (!verdict.matches_brief) {
      skipped.push({
        org_name: row.org_name,
        reason: `page contradicts the brief: ${verdict.reason || 'no reason given'}`,
      });
      continue;
    }

    const merged: ValidatedRow = { ...row, category: verdict.category.trim() || row.category };
    for (const field of VERIFIABLE_FIELDS) {
      const value = verdict[field].trim();
      if (value) merged[field] = value;
    }
    const tier = verdict.tier.trim().toUpperCase();
    if ((TIERS as readonly string[]).includes(tier)) merged.tier = tier as Tier;

    kept.push(merged);
  }

  return { kept, skipped };
}

export function stripDomain(row: ValidatedRow): LeadRow {
  const { domain: _domain, ...rest } = row;
  return rest;
}

export function rowToCells(row: LeadRow): string[] {
  return RESEARCH_COLUMNS.map((key) => String(row[key] ?? ''));
}

export function claim(dedup: DedupSet, rows: ValidatedRow[]): void {
  for (const row of rows) {
    dedup.domains.add(row.domain);
    dedup.names.add(row.org_name.toLowerCase());
  }
}
