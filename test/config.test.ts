import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from '../src/config.ts';

const base = {
  MASTER_EVENTS_ID: 'sheet-123',
  TINYFISH_API_KEY: 'tf',
  CF_ACCOUNT_ID: 'cf',
  CF_AI_TOKEN: 'token',
  GOOGLE_OAUTH_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
  GOOGLE_OAUTH_REFRESH_TOKEN: '1//refresh',
};

describe('loadConfig', () => {
  test('applies documented defaults', () => {
    const config = loadConfig(base);
    expect(config.CAMPAIGNS_TAB).toBe('CAMPAIGNS');
    expect(config.CF_MODEL).toBe('@cf/zai-org/glm-5.2');
    expect(config.PORT).toBe(8787);
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.SCHEDULE).toBe('0 6 * * *');
    expect(config.TIMEZONE).toBe('Asia/Kolkata');
    expect(config.SCHEDULE_ENABLED).toBe(true);
    expect(config.DEFAULT_DAILY_LIMIT).toBe(13);
    expect(config.RETRY_ATTEMPTS).toBe(3);
  });

  test('lists every missing required value at once', () => {
    try {
      loadConfig({});
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join(' ');
      expect(issues).toContain('MASTER_EVENTS_ID');
      expect(issues).toContain('TINYFISH_API_KEY');
      expect(issues).toContain('CF_ACCOUNT_ID');
      expect(issues).toContain('CF_AI_TOKEN');
      expect(issues).toContain('GOOGLE_OAUTH_CLIENT_ID');
      expect(issues).toContain('GOOGLE_OAUTH_CLIENT_SECRET');
      expect(issues).toContain('GOOGLE_OAUTH_REFRESH_TOKEN');
    }
  });

  test('clamps numbers into range and ignores junk', () => {
    expect(loadConfig({ ...base, PORT: '99999' }).PORT).toBe(65535);
    expect(loadConfig({ ...base, MAX_ROUNDS: 'abc' }).MAX_ROUNDS).toBe(3);
    expect(loadConfig({ ...base, DEFAULT_DAILY_LIMIT: '900' }).DEFAULT_DAILY_LIMIT).toBe(50);
  });

  test('parses booleans the way an env file writes them', () => {
    expect(loadConfig({ ...base, SCHEDULE_ENABLED: 'false' }).SCHEDULE_ENABLED).toBe(false);
    expect(loadConfig({ ...base, SCHEDULE_ENABLED: '0' }).SCHEDULE_ENABLED).toBe(false);
    expect(loadConfig({ ...base, CF_STRUCTURED_OUTPUTS: 'yes' }).CF_STRUCTURED_OUTPUTS).toBe(true);
  });
});

describe('Google OAuth credentials', () => {
  test('are collected into config.google', () => {
    expect(loadConfig(base).google).toEqual({
      client_id: 'id.apps.googleusercontent.com',
      client_secret: 'secret',
      refresh_token: '1//refresh',
    });
  });

  test('each missing value names itself and points at the auth command', () => {
    for (const key of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN']) {
      const { [key]: _omit, ...partial } = base as Record<string, string>;
      try {
        loadConfig(partial);
        throw new Error(`should have thrown for ${key}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const issues = (error as ConfigError).issues.join(' ');
        expect(issues).toContain(`${key} is required`);
        expect(issues).toContain('bun run cli auth');
      }
    }
  });

  test('an empty value is treated as missing, not as a valid credential', () => {
    expect(() => loadConfig({ ...base, GOOGLE_OAUTH_REFRESH_TOKEN: '' })).toThrow(/GOOGLE_OAUTH_REFRESH_TOKEN/);
  });

  test('service account variables are no longer honoured', () => {
    const { GOOGLE_OAUTH_REFRESH_TOKEN: _omit, ...withoutToken } = base;
    expect(() =>
      loadConfig({
        ...withoutToken,
        GOOGLE_SA_JSON: JSON.stringify({ client_email: 'bot@x.iam.gserviceaccount.com', private_key: 'k' }),
        GOOGLE_SA_FILE: '/etc/campaign-research/service-account.json',
      }),
    ).toThrow(/GOOGLE_OAUTH_REFRESH_TOKEN/);
  });
});
