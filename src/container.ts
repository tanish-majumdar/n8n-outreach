import type { Config } from './config.ts';
import { createResearchModel } from './clients/model.ts';
import { createNotifier } from './clients/notify.ts';
import { createSearchClient } from './clients/tinyfish.ts';
import { createSheetsClient } from './clients/sheets.ts';
import { createMemoryStore } from './store/memory-store.ts';
import { createRunStore, type RunStore } from './store/run-store.ts';
import { createRunner, type Runner } from './runner.ts';
import type { Deps } from './types.ts';

export interface Container {
  config: Config;
  deps: Deps;
  runs: RunStore;
  runner: Runner;
}

export function createContainer(config: Config): Container {
  const deps: Deps = {
    sheets: createSheetsClient(config),
    search: createSearchClient(config),
    model: createResearchModel(config),
    memory: createMemoryStore(config.STATE_DIR),
    notifier: createNotifier(config),
    now: () => Date.now(),
  };
  const runs = createRunStore(config.STATE_DIR, config.RUN_HISTORY);
  return { config, deps, runs, runner: createRunner(deps, config, runs) };
}
