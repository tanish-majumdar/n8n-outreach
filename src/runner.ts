import type { Config } from './config.ts';
import { logger } from './logger.ts';
import { hasFailures, runAll, summarize, totalAppended, type RunOptions } from './core/pipeline.ts';
import type { RunRecord, RunStore } from './store/run-store.ts';
import type { Deps } from './types.ts';

export class RunInProgressError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`A run is already in progress (${runId})`);
    this.name = 'RunInProgressError';
    this.runId = runId;
  }
}

export interface StartOptions extends RunOptions {
  trigger: RunRecord['trigger'];
}

export interface Runner {
  start(options: StartOptions): Promise<RunRecord>;
  run(options: StartOptions): Promise<RunRecord>;
  current(): RunRecord | null;
}

function makeId(now: number, random: () => number): string {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const suffix = Math.floor(random() * 0xffffff).toString(16).padStart(6, '0');
  return `${stamp}-${suffix}`;
}

export function createRunner(
  deps: Deps,
  config: Config,
  store: RunStore,
  random: () => number = Math.random,
): Runner {
  let active: RunRecord | null = null;

  async function begin(options: StartOptions): Promise<RunRecord> {
    if (active) throw new RunInProgressError(active.id);
    const startedAt = deps.now();
    const record: RunRecord = {
      id: makeId(startedAt, random),
      status: 'running',
      dry: options.dry,
      trigger: options.trigger,
      startedAt: new Date(startedAt).toISOString(),
    };
    active = record;
    await store.save(record);
    logger.info({ runId: record.id, trigger: options.trigger, dry: options.dry }, 'run started');
    return record;
  }

  async function finish(record: RunRecord, options: StartOptions): Promise<RunRecord> {
    const startedAt = Date.parse(record.startedAt);
    try {
      const result = await runAll(deps, config, options);
      record.result = result;
      record.summary = summarize(result);
      record.appended = totalAppended(result);
      record.status = hasFailures(result) ? 'partial' : 'ok';
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.summary = `campaign research FAILED: ${record.error}`;
      logger.error({ runId: record.id, error: record.error }, 'run failed');
    } finally {
      record.finishedAt = new Date(deps.now()).toISOString();
      record.durationMs = deps.now() - startedAt;
      active = null;
      await store.save(record);
    }

    if (!options.dry || record.status !== 'ok') await deps.notifier.send(record.summary ?? '');
    logger.info({ runId: record.id, status: record.status, appended: record.appended }, 'run finished');
    return record;
  }

  return {
    current() {
      return active;
    },

    async run(options: StartOptions): Promise<RunRecord> {
      return finish(await begin(options), options);
    },

    async start(options: StartOptions): Promise<RunRecord> {
      const record = await begin(options);
      void finish(record, options).catch((error) =>
        logger.error({ runId: record.id, error: String(error) }, 'background run threw'),
      );
      return record;
    },
  };
}
