import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '../logger.ts';
import { emptyMemory, parseMemory, trimMemory } from '../core/memory.ts';
import type { Memory, MemoryStore } from '../types.ts';

export function createMemoryStore(stateDir: string, keepRuns = 400): MemoryStore {
  const file = join(stateDir, 'memory.json');

  return {
    async load(): Promise<Memory> {
      try {
        return parseMemory(JSON.parse(await readFile(file, 'utf8')));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') logger.warn({ file, error: String(error) }, 'memory unreadable, starting fresh');
        return emptyMemory();
      }
    },

    async save(memory: Memory): Promise<void> {
      const trimmed = trimMemory(memory, keepRuns);
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(trimmed, null, 2)}\n`);
      await rename(tmp, file);
    },
  };
}

export const inMemoryStore = (initial: Memory = emptyMemory()): MemoryStore => {
  let current = initial;
  return {
    async load() {
      return current;
    },
    async save(memory) {
      current = memory;
    },
  };
};
