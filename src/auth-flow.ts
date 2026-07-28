import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_SCOPE, type GoogleAuth } from './config.ts';

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export const DEFAULT_AUTH_PORT = 8788;

const FLUSH_MS = 250;

export interface AuthFlowResult {
  refreshToken: string;
  account: string;
}

export interface AuthFlowHandles {
  url: string;
  redirectUri: string;
  completed: Promise<AuthFlowResult>;
  cancel(): void;
}

export function redirectUriFor(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:16px system-ui;padding:3rem;max-width:34rem;margin:auto"><h2>${title}</h2><p>${body}</p></body>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );

export function startAuthFlow(
  clientId: string,
  clientSecret: string,
  port: number = DEFAULT_AUTH_PORT,
): AuthFlowHandles {
  const redirectUri = redirectUriFor(port);
  let settle: (result: AuthFlowResult) => void;
  let fail: (error: Error) => void;
  const completed = new Promise<AuthFlowResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/callback') return new Response('not found', { status: 404 });

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        fail(new Error(error ?? 'Google returned no authorisation code'));
        return page('Authorisation failed', error ?? 'No code was returned. Close this tab and try again.');
      }

      try {
        const result = await exchange(clientId, clientSecret, redirectUri, code);
        settle(result);
        return page('Authorised', `Signed in as <b>${result.account}</b>. Close this tab and return to your terminal.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fail(new Error(message));
        return page('Authorisation failed', message);
      }
    },
  });

  const url = new OAuth2Client({ clientId, clientSecret, redirectUri }).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [GOOGLE_SCOPE, 'https://www.googleapis.com/auth/userinfo.email'],
  });

  const stop = () => void server.stop(true);
  const close = () => setTimeout(stop, FLUSH_MS).unref();
  void completed.then(close, close);

  return { url, redirectUri, completed, cancel: stop };
}

async function exchange(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
): Promise<AuthFlowResult> {
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google returned no refresh token. Revoke this app at https://myaccount.google.com/permissions, then run auth again.',
    );
  }
  client.setCredentials(tokens);

  try {
    const info = await client.request<{ email?: string }>({ url: USERINFO_URL });
    return { refreshToken: tokens.refresh_token, account: info.data.email ?? 'unknown' };
  } catch {
    return { refreshToken: tokens.refresh_token, account: 'unknown' };
  }
}

export async function authorisedAccount(google: GoogleAuth): Promise<string> {
  const client = new OAuth2Client({ clientId: google.client_id, clientSecret: google.client_secret });
  client.setCredentials({ refresh_token: google.refresh_token });
  try {
    const info = await client.request<{ email?: string }>({ url: USERINFO_URL });
    return info.data.email ?? 'unknown account';
  } catch {
    return 'unknown account (userinfo scope not granted)';
  }
}
