import { LEAD_HEADER, type CampaignReport, type Deps, type PreflightEntry, type RunResult } from '../types.ts';
import { buildDedupSet, campaignTabNames, claim, parseCampaigns, rowToCells, stripDomain } from './campaigns.ts';
import { cachedAngles, digestToPrompt, memoryDigest, recordRun, rememberAngles } from './memory.ts';
import { NoAnglesError, researchCampaign } from './research.ts';
import { logger, stopwatch } from '../logger.ts';
import type { Config } from '../config.ts';

export interface RunOptions {
  dry: boolean;
  limitOverride: number | null;
}

const DAY_MS = 86_400_000;

export async function runAll(deps: Deps, config: Config, options: RunOptions): Promise<RunResult> {
  const now = deps.now();
  const started = new Date(now).toISOString();
  const campaignsTab = config.CAMPAIGNS_TAB;

  logger.info({ tab: campaignsTab, spreadsheet: config.MASTER_EVENTS_ID }, 'reading control tab');
  const readControl = stopwatch();
  const control = await deps.sheets.readTab(campaignsTab);
  if (!control) throw new Error(`${campaignsTab} tab not found in the spreadsheet`);
  logger.info({ rows: control.rows.length, ms: readControl() }, 'control tab read');

  const campaigns = parseCampaigns(control.rows, { defaultLimit: config.DEFAULT_DAILY_LIMIT });
  const active = campaigns.filter((c) => c.research_ready);
  const notReady = campaigns.filter((c) => !c.research_ready).map((c) => c.campaign_id);
  logger.info(
    { active: active.map((c) => c.campaign_id), not_ready: notReady, dry: options.dry },
    `${active.length} active campaign(s)`,
  );

  const existingTabs = await deps.sheets.listTabs();
  const preflight: PreflightEntry[] = [];
  for (const campaign of active) {
    if (existingTabs.includes(campaign.tab)) {
      preflight.push({ campaign_id: campaign.campaign_id, tab: campaign.tab, status: 'exists' });
    } else if (options.dry) {
      logger.info({ tab: campaign.tab }, 'tab missing, would create it');
      preflight.push({ campaign_id: campaign.campaign_id, tab: campaign.tab, status: 'would create' });
    } else {
      logger.info({ tab: campaign.tab }, 'creating campaign tab');
      await deps.sheets.ensureTab(campaign.tab, LEAD_HEADER);
      preflight.push({ campaign_id: campaign.campaign_id, tab: campaign.tab, status: 'created' });
    }
  }

  const knownTabs = campaignTabNames(control.rows);
  const leadTabs = existingTabs.filter((t) => t !== campaignsTab && knownTabs.includes(t));
  const ignored = existingTabs.filter((t) => t !== campaignsTab && !knownTabs.includes(t));
  logger.info({ tabs: leadTabs, ignored: ignored.length }, 'reading campaign tabs to build the dedup set');
  const readTabs = stopwatch();
  const dedup = buildDedupSet(await Promise.all(leadTabs.map((tab) => deps.sheets.readTab(tab))));
  logger.info({ domains: dedup.domains.size, names: dedup.names.size, ms: readTabs() }, 'dedup set built');

  const memory = await deps.memory.load();
  const dayIndex = Math.floor(now / DAY_MS);
  const date = started.slice(0, 10);
  const reports: CampaignReport[] = [];

  for (const campaign of active) {
    const limit = options.limitOverride ?? campaign.research_daily_limit;
    const report: CampaignReport = {
      campaign_id: campaign.campaign_id,
      tab: campaign.tab,
      limit,
      appended: 0,
    };

    const elapsed = stopwatch();
    try {
      const digest = memoryDigest(memory, campaign.campaign_id);
      report.memory = digest;
      logger.info(
        {
          campaign: campaign.campaign_id,
          limit,
          tab: campaign.tab,
          memory_runs: digest.runs_considered,
          productive: digest.productive.length,
        },
        'campaign start',
      );

      let angles = cachedAngles(memory, campaign.campaign_id, campaign.research_brief);
      if (angles) {
        logger.info({ campaign: campaign.campaign_id, angles }, 'reusing cached angles');
      } else {
        const deriving = stopwatch();
        angles = await deps.model.deriveAngles(campaign.research_brief);
        if (!angles.length) throw new NoAnglesError(campaign.campaign_id);
        rememberAngles(memory, campaign.campaign_id, campaign.research_brief, angles);
        logger.info({ campaign: campaign.campaign_id, angles, ms: deriving() }, 'derived search angles from the brief');
      }

      const { kept, skipped, trace } = await researchCampaign(deps, campaign, {
        limit,
        dedup,
        dayIndex,
        angles,
        location: config.SEARCH_LOCATION,
        memoryPrompt: digestToPrompt(digest),
        queriesPerRound: config.QUERIES_PER_ROUND,
        maxRounds: config.MAX_ROUNDS,
        verify: true,
      });

      report.trace = trace;
      report.skipped = skipped;
      report.rows = kept.map(stripDomain);

      if (kept.length && !options.dry) {
        logger.info({ campaign: campaign.campaign_id, tab: campaign.tab, rows: kept.length }, 'appending rows A:K');
        await deps.sheets.appendRows(campaign.tab, report.rows.map(rowToCells));
        report.appended = kept.length;
      } else if (kept.length) {
        logger.info({ campaign: campaign.campaign_id, rows: kept.length }, 'dry run, not appending');
      }

      claim(dedup, kept);

      if (!options.dry) {
        recordRun(memory, {
          date,
          campaign_id: campaign.campaign_id,
          rounds: trace.rounds_used,
          kept: kept.length,
          queries: trace.query_yield,
        });
      }
      logger.info(
        {
          campaign: campaign.campaign_id,
          kept: kept.length,
          appended: report.appended,
          skipped: skipped.length,
          rounds: trace.rounds_used,
          ms: elapsed(),
        },
        'campaign done',
      );
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      logger.error({ campaign: campaign.campaign_id, error: report.error, ms: elapsed() }, 'campaign failed');
    }
    reports.push(report);
  }

  if (!options.dry) await deps.memory.save(memory);

  return {
    started,
    finished: new Date(deps.now()).toISOString(),
    dry: options.dry,
    spreadsheet: config.MASTER_EVENTS_ID,
    preflight,
    not_ready: notReady,
    dedup_size: dedup.domains.size,
    campaigns: reports,
  };
}

export function summarize(result: RunResult): string {
  const lines = [`campaign research ${result.dry ? '(dry run) ' : ''}${result.started}`];
  for (const c of result.campaigns) {
    if (c.error) {
      lines.push(`  ${c.campaign_id}: FAILED - ${c.error}`);
    } else if (!c.appended && !c.rows?.length) {
      lines.push(`  ${c.campaign_id}: 0 leads (${c.trace?.error ?? 'nothing new'})`);
    } else {
      const count = result.dry ? (c.rows?.length ?? 0) : c.appended;
      lines.push(`  ${c.campaign_id}: ${count} ${result.dry ? 'would append' : 'appended'}, ${c.skipped?.length ?? 0} skipped`);
    }
  }
  if (result.not_ready.length) lines.push(`  not ready (no research_brief): ${result.not_ready.join(', ')}`);
  const created = result.preflight.filter((p) => p.status === 'created').map((p) => p.tab);
  if (created.length) lines.push(`  tabs created: ${created.join(', ')}`);
  return lines.join('\n');
}

export function totalAppended(result: RunResult): number {
  return result.campaigns.reduce((sum, c) => sum + c.appended, 0);
}

export function hasFailures(result: RunResult): boolean {
  return result.campaigns.some((c) => c.error);
}
