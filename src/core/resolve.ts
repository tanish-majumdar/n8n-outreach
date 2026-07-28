import { normalizeDomain } from './campaigns.ts';
import type { SearchClient, SearchHit } from '../types.ts';

const NOT_A_HOMEPAGE = [
  'wikipedia.org', 'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'reddit.com', 'quora.com', 'medium.com', 'substack.com',
  'crunchbase.com', 'pitchbook.com', 'tracxn.com', 'f6s.com', 'glassdoor.com', 'indeed.com',
  'welcometothejungle.com', 'bloomberg.com', 'forbes.com', 'techcrunch.com', 'businesswire.com',
  'prnewswire.com', 'eu-startups.com', 'startupblink.com', 'google.com', 'apple.com', 'amazon.com',
  'yahoo.com', 'msn.com', 'slideshare.net', 'scribd.com', 'issuu.com',
];

const STOPWORDS = new Set([
  'the', 'and', 'of', 'for', 'group', 'network', 'association', 'programme', 'program', 'centre',
  'center', 'institute', 'foundation', 'company', 'limited', 'ltd', 'inc', 'llc', 'global',
  'international', 'national', 'studio', 'studios', 'ventures', 'venture', 'capital', 'partners',
]);

export function isExcludedHost(domain: string): boolean {
  return NOT_A_HOMEPAGE.some((host) => domain === host || domain.endsWith(`.${host}`));
}

export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function pathDepth(url: string): number {
  const path = url.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0] ?? '';
  return path.split('/').filter(Boolean).length;
}

export function scoreHomepage(orgName: string, hit: SearchHit, position: number): number {
  const domain = normalizeDomain(hit.url);
  if (!domain || isExcludedHost(domain)) return -1;

  const bare = domain.split('.').slice(0, -1).join('');
  const tokens = nameTokens(orgName);
  const matched = tokens.filter((t) => bare.includes(t)).length;

  let score = 0;
  if (matched) score += 50 + matched * 10;
  if (tokens.length && matched === tokens.length) score += 20;
  score += Math.max(0, 20 - position * 4);
  score -= pathDepth(hit.url) * 12;
  if (/\.pdf$/i.test(hit.url)) score -= 40;
  return score;
}

export function pickHomepage(orgName: string, results: SearchHit[]): string | null {
  let bestUrl: string | null = null;
  let bestScore = 0;

  results.forEach((hit, index) => {
    const score = scoreHomepage(orgName, hit, index);
    if (score <= bestScore) return;
    bestScore = score;
    bestUrl = `https://${normalizeDomain(hit.url)}`;
  });

  return bestUrl;
}

export function resolutionQuery(orgName: string, context?: string): string {
  const hint = (context ?? '').trim();
  return hint ? `${orgName} ${hint} official website` : `${orgName} official website`;
}

export async function resolveHomepage(
  search: SearchClient,
  orgName: string,
  opts: { location?: string; context?: string } = {},
): Promise<string | null> {
  const response = await search.search(resolutionQuery(orgName, opts.context), {
    purpose: 'find the organisation own homepage',
    ...(opts.location ? { location: opts.location } : {}),
  });
  if (response.error || !response.results.length) return null;
  return pickHomepage(orgName, response.results);
}
