import pRetry, { AbortError } from 'p-retry';
import type { Config } from '../config.ts';
import { logger } from '../logger.ts';
import type { SearchClient, SearchHit, SearchResponse } from '../types.ts';

const SEARCH_URL = 'https://api.search.tinyfish.ai';
const FETCH_URL = 'https://api.fetch.tinyfish.ai';
const URLS_PER_FETCH = 10;
const PAGE_CHAR_LIMIT = 4000;

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

interface SearchBody {
  results?: Partial<SearchHit>[];
}

interface FetchBody {
  results?: { url?: string; text?: unknown }[];
}

export function createSearchClient(config: Config, fetchImpl: typeof fetch = fetch): SearchClient {
  const retryOptions = { retries: config.RETRY_ATTEMPTS, minTimeout: config.RETRY_BASE_MS, factor: 2 };

  async function request(url: string, init: RequestInit): Promise<Response> {
    return pRetry(async () => {
      const res = await fetchImpl(url, init);
      if (RETRYABLE.has(res.status)) throw new Error(`TinyFish HTTP ${res.status}`);
      if (!res.ok) throw new AbortError(`TinyFish HTTP ${res.status}`);
      return res;
    }, retryOptions);
  }

  return {
    async search(query: string, { purpose, location }): Promise<SearchResponse> {
      const params = new URLSearchParams({ query, page: '0' });
      if (purpose) params.set('purpose', purpose.slice(0, 2000));
      if (location) params.set('location', location);

      try {
        const res = await request(`${SEARCH_URL}?${params}`, {
          headers: { 'X-API-Key': config.TINYFISH_API_KEY },
        });
        const body = (await res.json()) as SearchBody;
        const results = (body.results ?? []).map((r) => ({
          title: String(r.title ?? ''),
          snippet: String(r.snippet ?? ''),
          url: String(r.url ?? ''),
          site_name: String(r.site_name ?? ''),
          date: String(r.date ?? ''),
        }));
        return { query, results };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ query, error: message }, 'search failed');
        return { query, results: [], error: message };
      }
    },

    async fetchPages(urls: string[], { purpose }): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      const list = [...new Set(urls.filter(Boolean))];

      for (let i = 0; i < list.length; i += URLS_PER_FETCH) {
        const batch = list.slice(i, i + URLS_PER_FETCH);
        try {
          const res = await request(FETCH_URL, {
            method: 'POST',
            headers: { 'X-API-Key': config.TINYFISH_API_KEY, 'content-type': 'application/json' },
            body: JSON.stringify({
              urls: batch,
              format: 'markdown',
              ttl: 86400,
              per_url_timeout_ms: 20000,
              ...(purpose ? { purpose: purpose.slice(0, 2000) } : {}),
            }),
          });
          const body = (await res.json()) as FetchBody;
          for (const entry of body.results ?? []) {
            const text = typeof entry.text === 'string' ? entry.text : JSON.stringify(entry.text ?? '');
            if (entry.url && text) out.set(entry.url, text.slice(0, PAGE_CHAR_LIMIT));
          }
        } catch (error) {
          logger.warn({ batch: batch.length, error: String(error) }, 'page fetch batch failed');
        }
      }
      return out;
    },
  };
}
