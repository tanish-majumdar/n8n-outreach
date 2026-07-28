import { describe, expect, test } from 'bun:test';
import { coerceJsonContent, createSanitisingFetch, sanitiseCompletionBody } from '../src/clients/json.ts';

const completion = (content: string) =>
  JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content } }] });

describe('coerceJsonContent', () => {
  test('strips the ```json fences GLM wraps around valid JSON', () => {
    const fenced = '```json\n{\n  "queries": ["a", "b"]\n}\n```';
    expect(JSON.parse(coerceJsonContent(fenced))).toEqual({ queries: ['a', 'b'] });
  });

  test('strips bare ``` fences with no language tag', () => {
    expect(JSON.parse(coerceJsonContent('```\n{"rows":[]}\n```'))).toEqual({ rows: [] });
  });

  test('leaves already-clean JSON untouched', () => {
    expect(coerceJsonContent('{"queries":["a"]}')).toBe('{"queries":["a"]}');
  });

  test('recovers JSON buried in prose', () => {
    const prose = 'Here are the queries:\n{"queries": ["a"]}\nHope that helps.';
    expect(JSON.parse(coerceJsonContent(prose))).toEqual({ queries: ['a'] });
  });

  test('returns the original when nothing parses, so the caller still sees the raw text', () => {
    expect(coerceJsonContent('no json here at all')).toBe('no json here at all');
    expect(coerceJsonContent('')).toBe('');
  });

  test('does not mangle a JSON string that merely contains backticks', () => {
    const value = '{"queries":["use ``` in a query"]}';
    expect(JSON.parse(coerceJsonContent(value))).toEqual({ queries: ['use ``` in a query'] });
  });
});

describe('sanitiseCompletionBody', () => {
  test('unwraps fenced content inside a chat completion', () => {
    const body = sanitiseCompletionBody(completion('```json\n{"rows":[]}\n```'));
    expect(JSON.parse(body).choices[0].message.content).toBe('{"rows":[]}');
  });

  test('passes through a body it cannot parse', () => {
    expect(sanitiseCompletionBody('not json')).toBe('not json');
  });

  test('leaves a body with no fenced content byte-identical', () => {
    const raw = completion('{"rows":[]}');
    expect(sanitiseCompletionBody(raw)).toBe(raw);
  });
});

describe('createSanitisingFetch', () => {
  const json = (body: string, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } });

  test('cleans the response the model provider returns', async () => {
    const fetchImpl = createSanitisingFetch(async () => json(completion('```json\n{"queries":["a"]}\n```')));
    const res = await fetchImpl('https://x.test');
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(JSON.parse(body.choices[0]!.message.content)).toEqual({ queries: ['a'] });
  });

  test('passes non-JSON and error responses straight through', async () => {
    const html = new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    const res = await createSanitisingFetch(async () => html)('https://x.test');
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('<html>502</html>');
  });

  test('preserves the status code of a successful response', async () => {
    const res = await createSanitisingFetch(async () => json(completion('{"rows":[]}')))('https://x.test');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
