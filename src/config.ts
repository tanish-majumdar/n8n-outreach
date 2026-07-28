import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10);
      return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
    });

const AUTH_HINT = 'obtain it with: bun run cli auth';

const required = (name: string, hint?: string) => {
  const message = `${name} is required${hint ? ` (${hint})` : ''}`;
  return z.string({ required_error: message, invalid_type_error: message }).min(1, message);
};

const envSchema = z.object({
  GOOGLE_OAUTH_CLIENT_ID: required('GOOGLE_OAUTH_CLIENT_ID', AUTH_HINT),
  GOOGLE_OAUTH_CLIENT_SECRET: required('GOOGLE_OAUTH_CLIENT_SECRET', AUTH_HINT),
  GOOGLE_OAUTH_REFRESH_TOKEN: required('GOOGLE_OAUTH_REFRESH_TOKEN', AUTH_HINT),
  MASTER_EVENTS_ID: required('MASTER_EVENTS_ID', 'the spreadsheet id from its URL'),
  CAMPAIGNS_TAB: z.string().default('CAMPAIGNS'),
  TINYFISH_API_KEY: required('TINYFISH_API_KEY'),
  CF_ACCOUNT_ID: required('CF_ACCOUNT_ID'),
  CF_AI_TOKEN: required('CF_AI_TOKEN'),
  CF_MODEL: z.string().default('@cf/zai-org/glm-5.2'),
  CF_STRUCTURED_OUTPUTS: bool(true),
  MAX_QUERY_TOKENS: int(24_000, 256, 128_000),
  MAX_EXTRACT_TOKENS: int(96_000, 1024, 200_000),
  SEARCH_LOCATION: z.string().default(''),
  STATE_DIR: z.string().default('state'),
  PORT: int(8787, 1, 65535),
  HOST: z.string().default('127.0.0.1'),
  ADMIN_TOKEN: z.string().optional(),
  SCHEDULE: z.string().default('0 6 * * *'),
  TIMEZONE: z.string().default('Asia/Kolkata'),
  SCHEDULE_ENABLED: bool(true),
  RETRY_ATTEMPTS: int(3, 0, 10),
  RETRY_BASE_MS: int(500, 0, 60_000),
  QUERIES_PER_ROUND: int(3, 1, 10),
  MAX_ROUNDS: int(3, 1, 10),
  DEFAULT_DAILY_LIMIT: int(13, 1, 50),
  RUN_HISTORY: int(60, 1, 1000),
  SLACK_WEBHOOK: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export interface GoogleAuth {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export type Config = z.infer<typeof envSchema> & { google: GoogleAuth };

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Configuration invalid:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.join('.');
        return issue.message.startsWith(path) ? issue.message : `${path}: ${issue.message}`;
      }),
    );
  }
  return {
    ...parsed.data,
    google: {
      client_id: parsed.data.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: parsed.data.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: parsed.data.GOOGLE_OAUTH_REFRESH_TOKEN,
    },
  };
}
