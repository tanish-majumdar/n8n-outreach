import { z } from 'zod';

export const LEAD_HEADER = [
  'org_name', 'event_name', 'website', 'event_type', 'tier', 'region', 'dates_raw',
  'date_confidence', 'attendance', 'event_goal', 'category',
  'purpose', 'pitch_angle', 'status', 'chosen_person_name', 'chosen_person_title',
  'chosen_person_email', 'chosen_person_apollo_id', 'llm_reason', 'email_subject',
  'email_draft', 'thread_id', 'gmail_message_id', 'last_sent_date', 'followup_stage',
  'tracking_id', 'replied', 'replied_at', 'booked', 'booked_at', 'opens',
  'last_open_at', 'clicks', 'last_click_at',
] as const;

export const TIERS = ['T1', 'T2', 'T3'] as const;

export type Tier = (typeof TIERS)[number];

export const tierSchema = z.enum(TIERS);

const text = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .transform((value) => (value === null ? '' : String(value)));

export const leadRowSchema = z.object({
  org_name: z.string(),
  event_name: z.string(),
  website: z.string(),
  event_type: z.string(),
  tier: tierSchema,
  region: z.string(),
  dates_raw: z.string(),
  date_confidence: z.string(),
  attendance: z.string(),
  event_goal: z.string(),
  category: z.string(),
});

export type LeadRow = z.infer<typeof leadRowSchema>;

export const RESEARCH_COLUMNS = LEAD_HEADER.slice(0, 11) as readonly (keyof LeadRow)[];

export type ValidatedRow = LeadRow & { domain: string };

export const extractedRowSchema = z.object({
  org_name: text,
  event_name: text,
  website: text,
  event_type: text,
  tier: text,
  region: text,
  dates_raw: text,
  date_confidence: text,
  attendance: text,
  event_goal: text,
  category: text,
});

export type ExtractedRow = z.infer<typeof extractedRowSchema>;

export const querySetSchema = z.object({
  queries: z.array(text),
});

export const angleSetSchema = z.object({
  angles: z.array(text),
});

export const extractionSchema = z.object({
  rows: z.array(extractedRowSchema),
});

export const groundedRowSchema = z.object({
  org_name: text,
  event_type: text,
  tier: text,
  region: text,
  dates_raw: text,
  date_confidence: text,
  attendance: text,
  event_goal: text,
});

export type GroundedRow = z.infer<typeof groundedRowSchema>;

export const groundingSchema = z.object({
  rows: z.array(groundedRowSchema),
});

export const verifiedRowSchema = z.object({
  org_name: text,
  matches_brief: z.union([z.boolean(), z.string(), z.null()]).transform((v) => v === true || v === 'true'),
  reason: text,
  category: text,
  event_type: text,
  tier: text,
  region: text,
  dates_raw: text,
  date_confidence: text,
  attendance: text,
  event_goal: text,
});

export type VerifiedRow = z.infer<typeof verifiedRowSchema>;

export const verificationSchema = z.object({
  rows: z.array(verifiedRowSchema),
});

export interface Campaign {
  campaign_id: string;
  tab: string;
  research_brief: string;
  research_daily_limit: number;
  research_ready: boolean;
}

export interface DedupSet {
  domains: Set<string>;
  names: Set<string>;
}

export interface SkippedRow {
  org_name: string;
  reason: string;
}

export interface SearchHit {
  title: string;
  snippet: string;
  url: string;
  site_name: string;
  date: string;
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
  error?: string;
}

export interface QueryYield {
  q: string;
  hits: number;
  fresh: number;
  kept: number;
}

export interface RoundLog {
  round: number;
  angle: string;
  queries: string[];
  hits: number;
  fresh: number;
  kept: number;
  skipped: number;
  note?: string;
  rejected_by_verification?: number;
  error?: string;
  search_errors?: string[];
}

export interface ResearchTrace {
  campaign_id: string;
  rounds: RoundLog[];
  rounds_used: number;
  covered_hits: number;
  query_yield: QueryYield[];
  grounded?: { website: string; fetched: boolean }[];
  error?: string;
}

export interface CampaignReport {
  campaign_id: string;
  tab: string;
  limit: number;
  appended: number;
  rows?: LeadRow[];
  skipped?: SkippedRow[];
  trace?: ResearchTrace;
  memory?: MemoryDigest;
  error?: string;
}

export interface PreflightEntry {
  campaign_id: string;
  tab: string;
  status: 'exists' | 'created' | 'would create';
}

export interface RunResult {
  started: string;
  finished: string;
  dry: boolean;
  spreadsheet: string;
  preflight: PreflightEntry[];
  not_ready: string[];
  dedup_size: number;
  campaigns: CampaignReport[];
}

export interface MemoryQuery {
  q: string;
  hits: number;
  fresh: number;
  kept: number;
}

export interface MemoryRun {
  date: string;
  campaign_id: string;
  rounds: number;
  kept: number;
  queries: MemoryQuery[];
}

export interface CampaignAngles {
  brief_hash: string;
  angles: string[];
}

export interface Memory {
  version: number;
  runs: MemoryRun[];
  angles?: Record<string, CampaignAngles>;
}

export interface MemoryDigest {
  runs_considered: number;
  productive: { q: string; kept: number; uses: number }[];
  barren: string[];
}

export interface SheetTab {
  header: string[];
  rows: Record<string, string>[];
}

export interface SheetsClient {
  listTabs(): Promise<string[]>;
  readTab(tab: string): Promise<SheetTab | null>;
  ensureTab(tab: string, header: readonly string[]): Promise<{ created: boolean }>;
  appendRows(tab: string, rows: string[][]): Promise<{ appended: number }>;
}

export interface SearchClient {
  search(query: string, opts: { purpose?: string; location?: string }): Promise<SearchResponse>;
  fetchPages(urls: string[], opts: { purpose?: string }): Promise<Map<string, string>>;
}

export interface QueryRequest {
  brief: string;
  angle: string;
  count: number;
  feedback?: string;
  memoryPrompt?: string;
}

export interface ExtractRequest {
  brief: string;
  angle: string;
  covered: string[];
  maxRows: number;
  hits: SearchHit[];
}

export interface GroundRequest {
  rows: LeadRow[];
  pages: Map<string, string>;
}

export interface VerifyRequest {
  brief: string;
  categories: string[];
  rows: LeadRow[];
  pages: Map<string, string>;
}

export interface ResearchModel {
  deriveAngles(brief: string): Promise<string[]>;
  generateQueries(req: QueryRequest): Promise<string[]>;
  extractRows(req: ExtractRequest): Promise<ExtractedRow[]>;
  groundRows(req: GroundRequest): Promise<GroundedRow[]>;
  verifyRows(req: VerifyRequest): Promise<VerifiedRow[]>;
}

export interface MemoryStore {
  load(): Promise<Memory>;
  save(memory: Memory): Promise<void>;
}

export interface Notifier {
  send(text: string): Promise<void>;
}

export interface Deps {
  sheets: SheetsClient;
  search: SearchClient;
  model: ResearchModel;
  memory: MemoryStore;
  notifier: Notifier;
  now: () => number;
}
