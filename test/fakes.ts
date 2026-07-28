import type { Config } from '../src/config.ts';
import { emptyMemory } from '../src/core/memory.ts';
import { inMemoryStore } from '../src/store/memory-store.ts';
import type {
  Deps,
  ExtractRequest,
  ExtractedRow,
  GroundRequest,
  GroundedRow,
  Memory,
  Notifier,
  QueryRequest,
  ResearchModel,
  SearchClient,
  SearchHit,
  SheetTab,
  SheetsClient,
  VerifiedRow,
  VerifyRequest,
} from '../src/types.ts';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    GOOGLE_OAUTH_CLIENT_ID: 'id.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    GOOGLE_OAUTH_REFRESH_TOKEN: '1//refresh-token',
    MASTER_EVENTS_ID: 'sheet-123',
    CAMPAIGNS_TAB: 'CAMPAIGNS',
    TINYFISH_API_KEY: 'tf-key',
    CF_ACCOUNT_ID: 'cf-account',
    CF_AI_TOKEN: 'cf-token',
    CF_MODEL: '@cf/zai-org/glm-5.2',
    CF_STRUCTURED_OUTPUTS: true,
    MAX_QUERY_TOKENS: 24_000,
    MAX_EXTRACT_TOKENS: 96_000,
    SEARCH_LOCATION: 'IN',
    STATE_DIR: 'state',
    PORT: 8787,
    HOST: '127.0.0.1',
    ADMIN_TOKEN: undefined,
    SCHEDULE: '0 6 * * *',
    TIMEZONE: 'Asia/Kolkata',
    SCHEDULE_ENABLED: false,
    RETRY_ATTEMPTS: 0,
    RETRY_BASE_MS: 0,
    QUERIES_PER_ROUND: 2,
    MAX_ROUNDS: 3,
    DEFAULT_DAILY_LIMIT: 13,
    RUN_HISTORY: 60,
    SLACK_WEBHOOK: undefined,
    LOG_LEVEL: 'silent',
    google: {
      client_id: 'id.apps.googleusercontent.com',
      client_secret: 'client-secret',
      refresh_token: '1//refresh-token',
    },
    ...overrides,
  };
}

export class FakeSheets implements SheetsClient {
  readonly tabs = new Map<string, SheetTab>();
  readonly appended: { tab: string; rows: string[][] }[] = [];
  readonly created: string[] = [];

  constructor(tabs: Record<string, Record<string, string>[]> = {}) {
    for (const [name, rows] of Object.entries(tabs)) {
      this.tabs.set(name, { header: Object.keys(rows[0] ?? {}), rows });
    }
  }

  async listTabs(): Promise<string[]> {
    return [...this.tabs.keys()];
  }

  async readTab(tab: string): Promise<SheetTab | null> {
    return this.tabs.get(tab) ?? null;
  }

  async ensureTab(tab: string, header: readonly string[]): Promise<{ created: boolean }> {
    if (this.tabs.has(tab)) return { created: false };
    this.tabs.set(tab, { header: [...header], rows: [] });
    this.created.push(tab);
    return { created: true };
  }

  async appendRows(tab: string, rows: string[][]): Promise<{ appended: number }> {
    this.appended.push({ tab, rows });
    return { appended: rows.length };
  }
}

export interface ScriptedRound {
  queries: string[];
  hits: Record<string, SearchHit[]>;
  rows: ExtractedRow[];
}

export class FakeResearch implements ResearchModel, SearchClient {
  readonly queryPrompts: QueryRequest[] = [];
  readonly angleBriefs: string[] = [];
  angles: string[] = ['scripted angle a', 'scripted angle b'];
  readonly extractPrompts: ExtractRequest[] = [];
  readonly fetchBatches: number[] = [];
  grounded: GroundedRow[] = [];
  readonly verifyRequests: VerifyRequest[] = [];
  verdicts: VerifiedRow[] | null = null;
  pages = new Map<string, string>();
  private index = -1;

  readonly homepages = new Map<string, string>();

  constructor(private readonly rounds: ScriptedRound[]) {
    for (const round of rounds) {
      for (const row of round.rows) {
        if (row.org_name && row.website) this.homepages.set(row.org_name.toLowerCase(), row.website);
      }
    }
  }

  private get round(): ScriptedRound | undefined {
    return this.rounds[Math.min(this.index, this.rounds.length - 1)];
  }

  async deriveAngles(brief: string): Promise<string[]> {
    this.angleBriefs.push(brief);
    return this.angles;
  }

  async generateQueries(req: QueryRequest): Promise<string[]> {
    this.index += 1;
    this.queryPrompts.push(req);
    return this.round?.queries ?? [];
  }

  async search(query: string): Promise<{ query: string; results: SearchHit[] }> {
    const resolution = query.match(/^(.*) official website$/);
    if (resolution) {
      const homepage = this.homepages.get(resolution[1]!.toLowerCase());
      return { query, results: homepage ? [hit(homepage)] : [] };
    }
    return { query, results: this.round?.hits[query] ?? [] };
  }

  async extractRows(req: ExtractRequest): Promise<ExtractedRow[]> {
    this.extractPrompts.push(req);
    return this.round?.rows ?? [];
  }

  async fetchPages(urls: string[]): Promise<Map<string, string>> {
    for (let i = 0; i < urls.length; i += 10) this.fetchBatches.push(urls.slice(i, i + 10).length);
    if (this.pages.size) return this.pages;
    return new Map(urls.map((u) => [u, `page text for ${u}`]));
  }

  async groundRows(_req: GroundRequest): Promise<GroundedRow[]> {
    return this.grounded;
  }

  async verifyRows(req: VerifyRequest): Promise<VerifiedRow[]> {
    this.verifyRequests.push(req);
    if (this.verdicts) return this.verdicts;
    return req.rows.map((r) => ({
      org_name: r.org_name,
      matches_brief: true,
      reason: 'scripted pass',
      category: req.categories[0] ?? r.category,
      event_type: '',
      tier: '',
      region: '',
      dates_raw: '',
      date_confidence: '',
      attendance: '',
      event_goal: '',
    }));
  }
}

export function hit(url: string, siteName = url): SearchHit {
  return { title: siteName, snippet: '', url, site_name: siteName, date: '' };
}

export function row(org: string, website: string, extra: Partial<ExtractedRow> = {}): ExtractedRow {
  return {
    org_name: org,
    event_name: '',
    website,
    event_type: '',
    tier: 'T2',
    region: '',
    dates_raw: '',
    date_confidence: '',
    attendance: '',
    event_goal: '',
    category: '',
    ...extra,
  };
}

export const collectingNotifier = (): Notifier & { sent: string[] } => {
  const sent: string[] = [];
  return { sent, async send(text: string) { sent.push(text); } };
};

export function testDeps(
  sheets: FakeSheets,
  research: FakeResearch,
  { memory = emptyMemory(), now = () => 1_700_000_000_000 }: { memory?: Memory; now?: () => number } = {},
): Deps & { notifier: Notifier & { sent: string[] } } {
  return {
    sheets,
    search: research,
    model: research,
    memory: inMemoryStore(memory),
    notifier: collectingNotifier(),
    now,
  };
}
