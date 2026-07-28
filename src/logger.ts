import pino from 'pino';

const LEVEL_NAMES: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

const useColour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const pretty = (process.env.LOG_FORMAT ?? (process.stdout.isTTY ? 'pretty' : 'json')) === 'pretty';

const paint = (code: string, text: string) => (useColour ? `\x1b[${code}m${text}\x1b[0m` : text);

const LEVEL_COLOUR: Record<number, string> = { 10: '90', 20: '90', 30: '36', 40: '33', 50: '31', 60: '35' };

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  return JSON.stringify(value) ?? String(value);
}

function format(line: string): string {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line;
  }

  const { level, time, msg, ms, campaign, ...rest } = record;
  const clock = new Date(typeof time === 'number' ? time : Date.now()).toTimeString().slice(0, 8);
  const name = LEVEL_NAMES[level as number] ?? 'info';
  const scope = campaign ? paint('35', `[${String(campaign)}] `) : '';
  const took = typeof ms === 'number' ? paint('90', ` ${ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`}`) : '';

  const fields = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${paint('90', `${k}=`)}${renderValue(v)}`)
    .join(' ');

  return `${paint('90', clock)} ${paint(LEVEL_COLOUR[level as number] ?? '36', name.padEnd(5))} ${scope}${String(msg ?? '')}${took}${fields ? `  ${fields}` : ''}\n`;
}

const destination = pretty
  ? {
      write(line: string) {
        process.stdout.write(format(line));
      },
    }
  : pino.destination(1);

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: undefined,
    redact: {
      paths: [
        'req.headers.authorization',
        'refresh_token',
        '*.refresh_token',
        'client_secret',
        '*.client_secret',
        'CF_AI_TOKEN',
        'TINYFISH_API_KEY',
        'ADMIN_TOKEN',
      ],
      censor: '[redacted]',
    },
  },
  destination,
);

export type Logger = typeof logger;

export function stopwatch(): () => number {
  const started = Date.now();
  return () => Date.now() - started;
}
