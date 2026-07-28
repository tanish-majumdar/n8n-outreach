export function coerceJsonContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return content;

  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '').replace(/\r?\n?```[\s]*$/, '').trim()
    : trimmed;

  if (parses(unfenced)) return unfenced;

  const match = unfenced.match(/[[{][\s\S]*[\]}]/);
  if (match && parses(match[0])) return match[0];

  return content;
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function sanitiseCompletionBody(raw: string): string {
  let body: { choices?: { message?: { content?: unknown } }[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return raw;
  }

  let changed = false;
  for (const choice of body.choices ?? []) {
    const message = choice?.message;
    if (!message) continue;

    if (message.content !== null && typeof message.content === 'object') {
      message.content = JSON.stringify(message.content);
      changed = true;
      continue;
    }
    if (typeof message.content !== 'string') continue;

    const cleaned = coerceJsonContent(message.content);
    if (cleaned !== message.content) {
      message.content = cleaned;
      changed = true;
    }
  }
  return changed ? JSON.stringify(body) : raw;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createSanitisingFetch(base: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const response = await base(input, init);
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.includes('application/json')) return response;

    const raw = await response.text();
    return new Response(sanitiseCompletionBody(raw), {
      status: response.status,
      statusText: response.statusText,
      headers: { 'content-type': 'application/json' },
    });
  };
}
