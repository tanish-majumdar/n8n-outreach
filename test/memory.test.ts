import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestToPrompt, emptyMemory, memoryDigest, parseMemory, recordRun, trimMemory } from '../src/core/memory.ts';
import { createMemoryStore } from '../src/store/memory-store.ts';
import type { Memory } from '../src/types.ts';

const q = (name: string, kept: number, hits = 4) => ({ q: name, hits, fresh: hits, kept });

function seeded(): Memory {
  const memory = emptyMemory();
  recordRun(memory, { date: '2026-07-01', campaign_id: 'alpha', rounds: 1, kept: 2, queries: [q('good query', 2), q('dud query', 0)] });
  recordRun(memory, { date: '2026-07-02', campaign_id: 'alpha', rounds: 1, kept: 1, queries: [q('good query', 1), q('dud query', 0)] });
  recordRun(memory, { date: '2026-07-02', campaign_id: 'beta', rounds: 1, kept: 5, queries: [q('beta query', 5)] });
  return memory;
}

describe('memoryDigest', () => {
  test('separates productive from barren query shapes', () => {
    const digest = memoryDigest(seeded(), 'alpha');
    expect(digest.runs_considered).toBe(2);
    expect(digest.productive.map((p) => p.q)).toEqual(['good query']);
    expect(digest.productive[0]).toEqual({ q: 'good query', kept: 3, uses: 2 });
    expect(digest.barren).toEqual(['dud query']);
  });

  test('is scoped to one campaign', () => {
    expect(memoryDigest(seeded(), 'beta').productive.map((p) => p.q)).toEqual(['beta query']);
  });

  test('a query with no hits at all is neither productive nor barren', () => {
    const memory = emptyMemory();
    recordRun(memory, { date: '2026-07-01', campaign_id: 'a', rounds: 1, kept: 0, queries: [{ q: 'silent', hits: 0, fresh: 0, kept: 0 }] });
    const digest = memoryDigest(memory, 'a');
    expect(digest.productive).toHaveLength(0);
    expect(digest.barren).toHaveLength(0);
  });

  test('considers only the most recent window of runs', () => {
    const memory = emptyMemory();
    for (let i = 0; i < 20; i++) {
      recordRun(memory, { date: `2026-07-${i}`, campaign_id: 'a', rounds: 1, kept: 0, queries: [] });
    }
    expect(memoryDigest(memory, 'a', { runs: 5 }).runs_considered).toBe(5);
  });
});

describe('digestToPrompt', () => {
  test('names productive shapes and tells the model not to copy them', () => {
    const prompt = digestToPrompt(memoryDigest(seeded(), 'alpha'));
    expect(prompt).toContain('good query');
    expect(prompt).toContain('do not copy them verbatim');
    expect(prompt).toContain('avoid these and close variants');
  });

  test('is empty when there is nothing to say', () => {
    expect(digestToPrompt(memoryDigest(emptyMemory(), 'nobody'))).toBe('');
    expect(digestToPrompt(undefined)).toBe('');
  });
});

describe('parseMemory and trimMemory', () => {
  test('rejects junk without throwing', () => {
    expect(parseMemory(null).runs).toEqual([]);
    expect(parseMemory({ runs: 'nope' }).runs).toEqual([]);
    expect(parseMemory('string').runs).toEqual([]);
  });

  test('trim keeps the newest runs', () => {
    const memory = emptyMemory();
    for (let i = 0; i < 10; i++) {
      recordRun(memory, { date: `d${i}`, campaign_id: 'a', rounds: 1, kept: 0, queries: [] });
    }
    const trimmed = trimMemory(memory, 3);
    expect(trimmed.runs.map((r) => r.date)).toEqual(['d7', 'd8', 'd9']);
  });
});

describe('createMemoryStore', () => {
  test('round-trips through disk and survives a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr-memory-'));
    const store = createMemoryStore(dir);

    expect((await store.load()).runs).toEqual([]);

    const memory = seeded();
    await store.save(memory);
    const reloaded = await store.load();
    expect(reloaded.runs).toHaveLength(3);
    expect(memoryDigest(reloaded, 'alpha').productive[0]!.q).toBe('good query');
  });

  test('a corrupt file starts fresh instead of crashing the run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr-memory-'));
    await writeFile(join(dir, 'memory.json'), '{ not json');
    expect((await createMemoryStore(dir).load()).runs).toEqual([]);
  });

  test('writes atomically via a temp file and leaves valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr-memory-'));
    await createMemoryStore(dir).save(seeded());
    const written = JSON.parse(await readFile(join(dir, 'memory.json'), 'utf8')) as Memory;
    expect(written.version).toBe(1);
    expect(written.runs).toHaveLength(3);
  });
});
