import { Command } from 'commander';
import { DEFAULT_AUTH_PORT, authorisedAccount, startAuthFlow } from './auth-flow.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createContainer } from './container.ts';
import { memoryDigest } from './core/memory.ts';

const program = new Command();

program.name('campaign-research').description('daily campaign-led partner research').version('2.0.0');

function build() {
  try {
    return createContainer(loadConfig());
  } catch (error) {
    if (error instanceof ConfigError) console.error(error.message);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function guard<T extends unknown[]>(action: (...args: T) => Promise<void>) {
  return async (...args: T): Promise<void> => {
    try {
      await action(...args);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  };
}

program
  .command('run', { isDefault: true })
  .description('run the research pipeline once and exit')
  .option('--dry', 'read everything, write nothing', false)
  .option('--limit <n>', 'cap leads per campaign', (v) => Number.parseInt(v, 10))
  .option('--json', 'print the full trace instead of the summary', false)
  .action(guard(async (options: { dry: boolean; limit?: number; json: boolean }) => {
    const container = build();
    const limit = Number.isFinite(options.limit) ? Math.min(Math.max(options.limit!, 1), 50) : null;
    const record = await container.runner.run({ dry: options.dry, limitOverride: limit, trigger: 'cli' });

    if (options.json) console.log(JSON.stringify(record, null, 2));
    else console.log(record.summary ?? record.error ?? '');

    process.exit(record.status === 'ok' ? 0 : record.status === 'partial' ? 2 : 1);
  }));

program
  .command('memory')
  .description('print what past runs learned about each campaign')
  .action(guard(async () => {
    const container = build();
    const memory = await container.deps.memory.load();
    const ids = [...new Set(memory.runs.map((r) => r.campaign_id))];
    if (!ids.length) {
      console.log(`no memory recorded yet under ${container.config.STATE_DIR}`);
      return;
    }
    for (const id of ids) {
      const digest = memoryDigest(memory, id);
      console.log(`\n${id}  (${digest.runs_considered} runs considered)`);
      for (const p of digest.productive) console.log(`  + ${p.q}  -> ${p.kept} kept over ${p.uses} runs`);
      for (const b of digest.barren) console.log(`  - ${b}  -> nothing usable`);
    }
  }));

program
  .command('runs')
  .description('list recorded runs')
  .action(guard(async () => {
    const container = build();
    const runs = await container.runs.list();
    if (!runs.length) console.log('no runs recorded yet');
    for (const r of runs) {
      console.log(`${r.id}  ${r.status.padEnd(8)}${r.dry ? 'dry  ' : '     '}${r.trigger.padEnd(9)}${r.appended ?? 0} appended`);
    }
  }));

program
  .command('auth')
  .description('obtain a Google OAuth refresh token for the Sheets API')
  .option('--client-id <id>', 'OAuth client id (defaults to GOOGLE_OAUTH_CLIENT_ID)')
  .option('--client-secret <secret>', 'OAuth client secret (defaults to GOOGLE_OAUTH_CLIENT_SECRET)')
  .option('--port <n>', 'loopback port for the callback', (v) => Number.parseInt(v, 10), DEFAULT_AUTH_PORT)
  .action(
    guard(async (options: { clientId?: string; clientSecret?: string; port: number }) => {
      const clientId = options.clientId ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = options.clientSecret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error(
          'Need an OAuth client. Create one at https://console.cloud.google.com/apis/credentials\n' +
            '  Application type: Desktop app\n' +
            'Then pass --client-id and --client-secret, or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
        );
      }

      const flow = startAuthFlow(clientId, clientSecret, options.port);
      console.log(`\nThe OAuth client must list this exact Authorised redirect URI:`);
      console.log(`  ${flow.redirectUri}`);
      console.log(`\nOpen this URL and approve access:\n\n${flow.url}\n`);
      console.log('Waiting for the callback…');

      const result = await flow.completed;
      console.log(`\nAuthorised as ${result.account}. Add these three lines to your env file:\n`);
      console.log(`GOOGLE_OAUTH_CLIENT_ID=${clientId}`);
      console.log(`GOOGLE_OAUTH_CLIENT_SECRET=${clientSecret}`);
      console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${result.refreshToken}\n`);
      console.log('Treat the refresh token as a password. Then run: bun run cli check');
    }),
  );

program
  .command('check')
  .description('validate configuration and Google Sheets access, then exit')
  .action(guard(async () => {
    const container = build();
    console.log(`authorised as: ${await authorisedAccount(container.config.google)}`);
    const tabs = await container.deps.sheets.listTabs();
    const control = await container.deps.sheets.readTab(container.config.CAMPAIGNS_TAB);
    console.log(`spreadsheet ok: ${tabs.length} tabs`);
    console.log(`${container.config.CAMPAIGNS_TAB}: ${control ? `${control.rows.length} rows` : 'NOT FOUND'}`);
    console.log(`model: ${container.config.CF_MODEL}`);
    process.exit(control ? 0 : 1);
  }));

await program.parseAsync(process.argv);
