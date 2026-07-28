import { OAuth2Client } from 'google-auth-library';
import type { Config, GoogleAuth } from '../config.ts';
import type { SheetTab, SheetsClient } from '../types.ts';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export function createGoogleAuth(google: GoogleAuth): OAuth2Client {
  const client = new OAuth2Client({ clientId: google.client_id, clientSecret: google.client_secret });
  client.setCredentials({ refresh_token: google.refresh_token });
  return client;
}

export function a1(tab: string, range: string): string {
  return `'${tab.replace(/'/g, "''")}'!${range}`;
}

export class SheetsError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SheetsError';
    this.status = status;
  }
}

interface ValuesResponse {
  values?: string[][];
}

interface SpreadsheetResponse {
  sheets?: { properties: { title: string; sheetId: number } }[];
}

export function createSheetsClient(config: Config): SheetsClient {
  const auth = createGoogleAuth(config.google);

  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    try {
      const res = await auth.request<T>({
        url: `${API}/${config.MASTER_EVENTS_ID}${path}`,
        method: (init.method ?? 'GET') as 'GET' | 'POST' | 'PUT',
        ...(init.body === undefined ? {} : { data: init.body }),
        retry: true,
        retryConfig: { retry: config.RETRY_ATTEMPTS, noResponseRetries: config.RETRY_ATTEMPTS },
      });
      return res.data;
    } catch (error) {
      const err = error as { response?: { status?: number; data?: { error?: { message?: string } } }; message?: string };
      const status = err.response?.status;
      const detail = err.response?.data?.error?.message ?? err.message ?? 'unknown error';
      const hint = status === 404 ? ' (can the authorised Google account open this spreadsheet?)' : '';
      throw new SheetsError(`Sheets ${path} failed: ${detail}${hint}`, status);
    }
  }

  return {
    async listTabs(): Promise<string[]> {
      const body = await call<SpreadsheetResponse>('?fields=sheets.properties(title,sheetId)');
      return (body.sheets ?? []).map((s) => s.properties.title);
    },

    async readTab(tab: string): Promise<SheetTab | null> {
      let body: ValuesResponse;
      try {
        body = await call<ValuesResponse>(`/values/${encodeURIComponent(a1(tab, 'A1:AZ'))}`);
      } catch (error) {
        if (error instanceof SheetsError && /Unable to parse range/i.test(error.message)) return null;
        throw error;
      }

      const values = body.values ?? [];
      const headerRow = values[0];
      if (!headerRow) return { header: [], rows: [] };

      const header = headerRow.map((h) => String(h ?? '').trim());
      const rows = values.slice(1).map((line) => {
        const row: Record<string, string> = {};
        header.forEach((key, col) => {
          if (key) row[key] = line[col] ?? '';
        });
        return row;
      });
      return { header, rows };
    },

    async ensureTab(tab: string, header: readonly string[]): Promise<{ created: boolean }> {
      const tabs = await this.listTabs();
      if (tabs.includes(tab)) return { created: false };

      await call(':batchUpdate', {
        method: 'POST',
        body: { requests: [{ addSheet: { properties: { title: tab } } }] },
      });
      await call(`/values/${encodeURIComponent(a1(tab, 'A1'))}?valueInputOption=RAW`, {
        method: 'PUT',
        body: { values: [header] },
      });
      return { created: true };
    },

    async appendRows(tab: string, rows: string[][]): Promise<{ appended: number }> {
      if (!rows.length) return { appended: 0 };
      const range = encodeURIComponent(a1(tab, 'A1'));
      await call(`/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: { values: rows },
      });
      return { appended: rows.length };
    },
  };
}
