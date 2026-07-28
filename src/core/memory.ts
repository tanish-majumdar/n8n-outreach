import type { Memory, MemoryDigest, MemoryRun, QueryYield } from '../types.ts';

export const MEMORY_VERSION = 1;

export function emptyMemory(): Memory {
  return { version: MEMORY_VERSION, runs: [], angles: {} };
}

export function trimMemory(memory: Memory, keepRuns = 400): Memory {
  return { version: MEMORY_VERSION, runs: memory.runs.slice(-keepRuns), angles: memory.angles ?? {} };
}

export function parseMemory(raw: unknown): Memory {
  if (!raw || typeof raw !== 'object') return emptyMemory();
  const candidate = raw as Partial<Memory>;
  if (!Array.isArray(candidate.runs)) return emptyMemory();
  return {
    version: candidate.version ?? MEMORY_VERSION,
    runs: candidate.runs,
    angles: candidate.angles ?? {},
  };
}

export function briefHash(brief: string): string {
  let hash = 5381;
  for (let i = 0; i < brief.length; i++) hash = ((hash * 33) ^ brief.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

export function cachedAngles(memory: Memory, campaignId: string, brief: string): string[] | null {
  const entry = memory.angles?.[campaignId];
  if (!entry || entry.brief_hash !== briefHash(brief) || !entry.angles.length) return null;
  return entry.angles;
}

export function rememberAngles(memory: Memory, campaignId: string, brief: string, angles: string[]): Memory {
  memory.angles = { ...(memory.angles ?? {}), [campaignId]: { brief_hash: briefHash(brief), angles } };
  return memory;
}

export function recordRun(
  memory: Memory,
  entry: { date: string; campaign_id: string; rounds: number; kept: number; queries: QueryYield[] },
): Memory {
  const run: MemoryRun = {
    date: entry.date,
    campaign_id: entry.campaign_id,
    rounds: entry.rounds,
    kept: entry.kept,
    queries: entry.queries.map((q) => ({ q: q.q, hits: q.hits, fresh: q.fresh, kept: q.kept })),
  };
  memory.runs.push(run);
  return memory;
}

export function memoryDigest(
  memory: Memory,
  campaignId: string,
  { runs = 14, maxItems = 10 }: { runs?: number; maxItems?: number } = {},
): MemoryDigest {
  const relevant = memory.runs.filter((r) => r.campaign_id === campaignId).slice(-runs);
  const stats = new Map<string, { q: string; uses: number; hits: number; fresh: number; kept: number }>();

  for (const run of relevant) {
    for (const q of run.queries ?? []) {
      const key = String(q.q ?? '').trim();
      if (!key) continue;
      const acc = stats.get(key) ?? { q: key, uses: 0, hits: 0, fresh: 0, kept: 0 };
      acc.uses += 1;
      acc.hits += q.hits ?? 0;
      acc.fresh += q.fresh ?? 0;
      acc.kept += q.kept ?? 0;
      stats.set(key, acc);
    }
  }

  const all = [...stats.values()];
  const productive = all
    .filter((s) => s.kept > 0)
    .sort((a, b) => b.kept / b.uses - a.kept / a.uses || b.kept - a.kept)
    .slice(0, maxItems);
  const barren = all
    .filter((s) => s.kept === 0 && s.hits > 0)
    .sort((a, b) => b.uses - a.uses)
    .slice(0, maxItems);

  return {
    runs_considered: relevant.length,
    productive: productive.map((s) => ({ q: s.q, kept: s.kept, uses: s.uses })),
    barren: barren.map((s) => s.q),
  };
}

export function digestToPrompt(digest: MemoryDigest | undefined): string {
  if (!digest || (!digest.productive.length && !digest.barren.length)) return '';
  const parts: string[] = [];
  if (digest.productive.length) {
    parts.push(
      `Query shapes that produced usable organisations in past runs (write new queries in this spirit, do not copy them verbatim):\n- ${digest.productive
        .map((p) => `${p.q}  (${p.kept} kept over ${p.uses} runs)`)
        .join('\n- ')}`,
    );
  }
  if (digest.barren.length) {
    parts.push(
      `Query shapes that returned results but never a usable organisation (avoid these and close variants):\n- ${digest.barren.join('\n- ')}`,
    );
  }
  return parts.join('\n\n');
}
