import { describe, expect, test } from 'bun:test';
import { isExcludedHost, nameTokens, pickHomepage, resolutionQuery, resolveHomepage } from '../src/core/resolve.ts';
import { hit } from './fakes.ts';
import type { SearchClient, SearchHit } from '../src/types.ts';

describe('isExcludedHost', () => {
  test('rejects profile, directory and publisher hosts', () => {
    for (const host of ['en.wikipedia.org', 'linkedin.com', 'www.crunchbase.com', 'medium.com', 'startupblink.com']) {
      expect(isExcludedHost(host.replace(/^www\./, ''))).toBe(true);
    }
  });

  test('accepts an ordinary company domain', () => {
    expect(isExcludedHost('antler.co')).toBe(false);
    expect(isExcludedHost('foundersfactory.com')).toBe(false);
  });
});

describe('nameTokens', () => {
  test('drops punctuation and generic words that every org shares', () => {
    expect(nameTokens('The Antler Venture Studio')).toEqual(['antler']);
    expect(nameTokens("Entrepreneurs' Organization")).toEqual(['entrepreneurs', 'organization']);
  });
});

describe('pickHomepage', () => {
  test('prefers the domain that matches the organisation name', () => {
    const results = [hit('https://en.wikipedia.org/wiki/Antler'), hit('https://www.antler.co/'), hit('https://f6s.com/antler')];
    expect(pickHomepage('Antler', results)).toBe('https://antler.co');
  });

  test('skips wikipedia, linkedin and directories even when they rank first', () => {
    const results = [
      hit('https://www.linkedin.com/company/founders-factory'),
      hit('https://en.wikipedia.org/wiki/Founders_Factory'),
      hit('https://foundersfactory.com/'),
    ];
    expect(pickHomepage('Founders Factory', results)).toBe('https://foundersfactory.com');
  });

  test('prefers the root domain over a deep sub-page of the same site', () => {
    const results = [hit('https://ulysseus.eu/research-and-innovate/innovation-hubs/'), hit('https://ulysseus.eu/')];
    expect(pickHomepage('Ulysseus', results)).toBe('https://ulysseus.eu');
  });

  test('accepts a renamed organisation whose domain does not match the old name', () => {
    const results = [hit('https://www.hexa.com/'), hit('https://en.wikipedia.org/wiki/Hexa_(company)')];
    expect(pickHomepage('eFounders', results)).toBe('https://hexa.com');
  });

  test('returns null when every result is excluded', () => {
    const results = [hit('https://www.linkedin.com/in/someone'), hit('https://en.wikipedia.org/wiki/Thing')];
    expect(pickHomepage('Some Org', results)).toBeNull();
  });

  test('returns null for no results at all', () => {
    expect(pickHomepage('Some Org', [])).toBeNull();
  });

  test('penalises PDFs so a report never becomes the homepage', () => {
    const results: SearchHit[] = [hit('https://uploads.webflow.com/top-20-venture-builders.pdf'), hit('https://acme.org/')];
    expect(pickHomepage('Acme', results)).toBe('https://acme.org');
  });
});

describe('resolutionQuery', () => {
  test('adds the campaign context so an ambiguous name resolves correctly', () => {
    expect(resolutionQuery('Beehive', 'UAE fintech')).toBe('Beehive UAE fintech official website');
  });

  test('omits the context when there is none', () => {
    expect(resolutionQuery('Antler', '')).toBe('Antler official website');
    expect(resolutionQuery('Antler')).toBe('Antler official website');
  });
});

describe('resolveHomepage', () => {
  const clientFor = (results: SearchHit[], error?: string): SearchClient & { queries: string[] } => {
    const queries: string[] = [];
    return {
      queries,
      async search(query) {
        queries.push(query);
        return error ? { query, results: [], error } : { query, results };
      },
      async fetchPages() {
        return new Map();
      },
    };
  };

  test('searches for the organisation by name and returns its homepage', async () => {
    const client = clientFor([hit('https://www.antler.co/')]);
    expect(await resolveHomepage(client, 'Antler')).toBe('https://antler.co');
    expect(client.queries).toEqual(['Antler official website']);
  });

  test('passes the region and type through as disambiguating context', async () => {
    const client = clientFor([hit('https://beehive.ae/')]);
    await resolveHomepage(client, 'Beehive', { context: 'UAE fintech' });
    expect(client.queries).toEqual(['Beehive UAE fintech official website']);
  });

  test('returns null when the search errors, rather than inventing a URL', async () => {
    expect(await resolveHomepage(clientFor([], 'search HTTP 429'), 'Antler')).toBeNull();
  });

  test('returns null when nothing usable comes back', async () => {
    expect(await resolveHomepage(clientFor([hit('https://en.wikipedia.org/wiki/Antler')]), 'Antler')).toBeNull();
  });
});
