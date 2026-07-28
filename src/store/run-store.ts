import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.ts';
import type { RunResult } from '../types.ts';

export type RunStatus = 'running' | 'ok' | 'partial' | 'failed';

export interface RunRecord {
  id: string;
  status: RunStatus;
  dry: boolean;
  trigger: 'schedule' | 'manual' | 'cli';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  appended?: number;
  summary?: string;
  error?: string;
  result?: RunResult;
}

export interface RunStore {
  list(): Promise<RunRecord[]>;
  get(id: string): Promise<RunRecord | null>;
  save(record: RunRecord): Promise<void>;
  latest(): Promise<RunRecord | null>;
}

const FILE = /^run-.*\.json$/;

export function createRunStore(stateDir: string, keep = 60): RunStore {
  const dir = join(stateDir, 'runs');

  async function names(): Promise<string[]> {
    try {
      return (await readdir(dir)).filter((n) => FILE.test(n)).sort().reverse();
    } catch {
      return [];
    }
  }

  async function read(name: string): Promise<RunRecord | null> {
    try {
      return JSON.parse(await readFile(join(dir, name), 'utf8')) as RunRecord;
    } catch {
      return null;
    }
  }

  const store: RunStore = {
    async list(): Promise<RunRecord[]> {
      const records = await Promise.all((await names()).map(read));
      return records.filter((r): r is RunRecord => r !== null).map(({ result: _result, ...meta }) => meta);
    },

    async get(id: string): Promise<RunRecord | null> {
      if (!/^[\w.:-]+$/.test(id)) return null;
      return read(`run-${id}.json`);
    },

    async save(record: RunRecord): Promise<void> {
      await mkdir(dir, { recursive: true });
      const target = join(dir, `run-${record.id}.json`);
      const tmp = `${target}.tmp`;
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
      await rename(tmp, target);

      const stale = (await names()).slice(keep);
      for (const name of stale) {
        await unlink(join(dir, name)).catch((error) => logger.warn({ name, error: String(error) }, 'prune failed'));
      }
    },

    async latest(): Promise<RunRecord | null> {
      const [first] = await names();
      return first ? read(first) : null;
    },
  };

  return store;
}
