import { logger, stopwatch } from '../logger.ts';
import { applyVerification, claim, normalizeDomain, stripDomain, validateRows } from './campaigns.ts';
import { resolveHomepage } from './resolve.ts';
import type { Campaign, DedupSet, ResearchTrace, RoundLog, SearchHit, SkippedRow, ValidatedRow } from '../types.ts';
import type { ResearchModel, SearchClient, QueryYield } from '../types.ts';

const MAX_COVERED_IN_PROMPT = 40;
const RESOLVE_HEADROOM = 6;

function summariseReasons(skipped: SkippedRow[]): string[] {
  const counts = new Map<string, number>();
  for (const item of skipped) {
    const key = item.reason.startsWith('page contradicts the brief')
      ? 'page contradicts the brief'
      : item.reason;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${n}x ${reason}`);
}
const DRY_ROUNDS_BEFORE_STOP = 2;

export class NoAnglesError extends Error {
  constructor(campaignId: string) {
    super(`No search angles could be derived from the research_brief for ${campaignId}`);
    this.name = 'NoAnglesError';
  }
}

export function pickAngle(dayIndex: number, angles: string[]): string {
  return angles[((dayIndex % angles.length) + angles.length) % angles.length]!;
}

export function buildFeedback(input: { tried: string[]; covered: string[]; need: number; round: number }): string {
  const lines = [`Round ${input.round}. You still need ${input.need} more organisations.`];
  if (input.tried.length) {
    lines.push(`Queries already tried (do not repeat or reword these):\n- ${input.tried.join('\n- ')}`);
  }
  if (input.covered.length) {
    lines.push(
      `Already in the sheet, so results that surface these are wasted:\n- ${input.covered
        .slice(0, MAX_COVERED_IN_PROMPT)
        .join('\n- ')}`,
    );
  }
  lines.push('Search somewhere those would not rank: change country, sub-category, or vocabulary.');
  return lines.join('\n\n');
}

export interface ResearchOptions {
  limit: number;
  dedup: DedupSet;
  queriesPerRound: number;
  maxRounds: number;
  dayIndex: number;
  location: string;
  memoryPrompt: string;
  verify: boolean;
  angles: string[];
}

export interface ResearchOutcome {
  kept: ValidatedRow[];
  skipped: SkippedRow[];
  trace: ResearchTrace;
}

interface Deps {
  model: ResearchModel;
  search: SearchClient;
}

export async function researchCampaign(
  deps: Deps,
  campaign: Campaign,
  options: ResearchOptions,
): Promise<ResearchOutcome> {
  const seen: DedupSet = {
    domains: new Set(options.dedup.domains),
    names: new Set(options.dedup.names),
  };
  const rounds: RoundLog[] = [];
  const kept: ValidatedRow[] = [];
  const skipped: SkippedRow[] = [];
  const tried: string[] = [];
  const covered = new Set<string>();
  const queryYield: QueryYield[] = [];
  const trail = logger.child({ campaign: campaign.campaign_id });
  let dryRounds = 0;

  if (!options.angles.length) throw new NoAnglesError(campaign.campaign_id);

  for (let round = 1; round <= options.maxRounds && kept.length < options.limit; round++) {
    const need = options.limit - kept.length;
    const angle = pickAngle(options.dayIndex + round - 1, options.angles);
    const feedback = round === 1 ? '' : buildFeedback({ tried, covered: [...covered], need, round });
    const log: RoundLog = { round, angle, queries: [], hits: 0, fresh: 0, kept: 0, skipped: 0 };

    trail.info({ round, angle, need, feedback: feedback ? 'yes' : 'no' }, `round ${round} start`);

    const askedQueries = stopwatch();
    const queries = await deps.model.generateQueries({
      brief: campaign.research_brief,
      angle,
      count: options.queriesPerRound,
      feedback,
      memoryPrompt: round === 1 ? options.memoryPrompt : '',
    });

    if (!queries.length) {
      log.error = 'model returned no search queries';
      trail.warn({ round, ms: askedQueries() }, 'model returned no search queries, stopping');
      rounds.push(log);
      break;
    }
    log.queries = queries;
    tried.push(...queries);
    trail.info({ round, queries, ms: askedQueries() }, `model wrote ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`);

    const hits: (SearchHit & { query: string })[] = [];
    const stats = new Map<string, QueryYield>();
    for (const query of queries) {
      const stat: QueryYield = { q: query, hits: 0, fresh: 0, kept: 0 };
      stats.set(query, stat);
      queryYield.push(stat);

      const searched = stopwatch();
      const response = await deps.search.search(query, {
        purpose: campaign.research_brief,
        location: options.location,
      });
      if (response.error) {
        log.search_errors = [...(log.search_errors ?? []), response.error];
        trail.warn({ round, q: query, error: response.error, ms: searched() }, 'search failed');
      } else {
        trail.info({ round, q: query, hits: response.results.length, ms: searched() }, 'searched');
      }
      stat.hits = response.results.length;
      hits.push(...response.results.map((r) => ({ ...r, query })));
    }
    log.hits = hits.length;

    const fresh: SearchHit[] = [];
    const thisRound = new Set<string>();
    const queryByDomain = new Map<string, string>();
    for (const hit of hits) {
      const domain = normalizeDomain(hit.url);
      if (!domain || thisRound.has(domain)) continue;
      thisRound.add(domain);
      if (seen.domains.has(domain)) {
        covered.add(hit.site_name || domain);
        continue;
      }
      queryByDomain.set(domain, hit.query);
      stats.get(hit.query)!.fresh += 1;
      const { query: _query, ...rest } = hit;
      fresh.push(rest);
    }
    log.fresh = fresh.length;
    trail.info(
      { round, hits: hits.length, fresh: fresh.length, already_covered: hits.length - fresh.length },
      'deduped search hits',
    );

    if (!fresh.length) {
      log.note = 'every hit was already covered';
      dryRounds += 1;
      trail.warn({ round, dry_rounds: dryRounds }, 'nothing new this round, skipping extraction');
      rounds.push(log);
      if (dryRounds >= DRY_ROUNDS_BEFORE_STOP) break;
      continue;
    }

    const extracting = stopwatch();
    trail.info({ round, hits: fresh.length }, 'extracting organisations from the fresh hits');
    const extracted = await deps.model.extractRows({
      brief: campaign.research_brief,
      angle,
      covered: [...covered],
      maxRows: need + 4,
      hits: fresh,
    });
    trail.info({ round, rows: extracted.length, ms: extracting() }, 'model returned rows');

    const resolving = stopwatch();
    const candidates = extracted.slice(0, need + RESOLVE_HEADROOM);
    let unresolved = 0;
    for (const candidate of candidates) {
      const homepage = await resolveHomepage(deps.search, candidate.org_name, {
        location: options.location,
        context: [candidate.region, candidate.event_type].filter(Boolean).join(' ').trim(),
      });
      if (homepage) {
        candidate.website = homepage;
      } else {
        candidate.website = '';
        unresolved += 1;
      }
    }
    trail.info(
      { round, resolved: candidates.length - unresolved, unresolved, ms: resolving() },
      'resolved official websites',
    );

    const result = validateRows(candidates, { dedup: seen, limit: need });
    for (const item of result.skipped) {
      if (item.reason.startsWith('already in a campaign tab')) covered.add(item.org_name);
    }

    const verified = options.verify
      ? await verifyAgainstPages(deps, campaign, result.kept, options, trail, round)
      : { kept: result.kept, skipped: [] as SkippedRow[] };

    claim(seen, verified.kept);
    for (const row of verified.kept) {
      const source = queryByDomain.get(row.domain);
      if (source) stats.get(source)!.kept += 1;
    }

    kept.push(...verified.kept);
    skipped.push(...result.skipped, ...verified.skipped);
    log.kept = verified.kept.length;
    log.skipped = result.skipped.length + verified.skipped.length;
    log.rejected_by_verification = verified.skipped.length;
    dryRounds = verified.kept.length ? 0 : dryRounds + 1;
    trail.info(
      {
        round,
        kept: verified.kept.map((r) => r.org_name),
        rejected: log.skipped,
        total: kept.length,
        target: options.limit,
      },
      `round ${round} kept ${verified.kept.length}`,
    );
    for (const item of [...result.skipped, ...verified.skipped]) {
      trail.debug({ round, org: item.org_name, reason: item.reason }, 'rejected');
    }
    rounds.push(log);
    if (dryRounds >= DRY_ROUNDS_BEFORE_STOP) break;
  }

  const trace: ResearchTrace = {
    campaign_id: campaign.campaign_id,
    rounds,
    rounds_used: rounds.length,
    covered_hits: covered.size,
    query_yield: queryYield,
  };

  if (!kept.length) {
    trace.error = rounds.some((r) => r.note) ? 'every search hit was already covered' : 'no valid rows found';
  }

  return { kept, skipped, trace };
}

async function verifyAgainstPages(
  deps: Deps,
  campaign: Campaign,
  rows: ValidatedRow[],
  options: ResearchOptions,
  trail: typeof logger,
  round: number,
): Promise<{ kept: ValidatedRow[]; skipped: SkippedRow[] }> {
  if (!rows.length) return { kept: [], skipped: [] };

  const fetching = stopwatch();
  const pages = await deps.search.fetchPages(
    rows.map((r) => r.website),
    { purpose: campaign.research_brief },
  );
  trail.info({ round, requested: rows.length, fetched: pages.size, ms: fetching() }, 'fetched candidate pages');

  const verifying = stopwatch();
  const verdicts = await deps.model.verifyRows({
    brief: campaign.research_brief,
    categories: options.angles,
    rows: rows.map(stripDomain),
    pages,
  });
  const outcome = applyVerification(rows, verdicts, { pages });
  trail.info(
    {
      round,
      confirmed: outcome.kept.length,
      rejected: outcome.skipped.length,
      why: summariseReasons(outcome.skipped),
      ms: verifying(),
    },
    'verified candidates against their own pages',
  );
  for (const item of outcome.skipped) {
    trail.debug({ round, org: item.org_name, reason: item.reason }, 'verification rejected');
  }
  return outcome;
}
