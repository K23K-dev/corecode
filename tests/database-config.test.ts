import { afterEach, describe, expect, it, vi } from 'vitest';

const { poolConfiguration } = vi.hoisted(() => ({ poolConfiguration: vi.fn() }));
vi.mock('pg', () => ({
  Pool: class {
    constructor(config: { connectionString: string }) {
      poolConfiguration(config);
    }
    on() {}
  },
}));

const databaseModule = '../server/database-config.mjs';
const { getDatabaseConnection, validateNeonConnectionString } = (await import(databaseModule)) as {
  getDatabaseConnection: () => { connectionString: string };
  validateNeonConnectionString: (value: unknown, variableName?: string) => URL;
};
const repositoryModule = '../server/repository.mjs';
const { makePool } = (await import(repositoryModule)) as {
  makePool: (connectionString: string) => unknown;
};

// Validation only: these synthetic URLs are never contacted.
const hostedUrl =
  'postgresql://test:test@ep-example-pooler.us-east-1.aws.neon.tech/practice?sslmode=require&channel_binding=require';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('Neon-only database configuration', () => {
  it('preserves the configured connection string and TLS parameters', () => {
    vi.stubEnv('POSTGRES_URL', hostedUrl);
    expect(getDatabaseConnection()).toEqual({ connectionString: hostedUrl });
  });

  it('does not consult the retired database alias', () => {
    vi.stubEnv('POSTGRES_URL', hostedUrl);
    vi.stubEnv('CODE_PRACTICE_DATABASE_URL', 'postgresql://test:test@localhost/practice');
    expect(getDatabaseConnection()).toEqual({ connectionString: hostedUrl });
  });

  it.each([undefined, '', '   '])('fails closed when POSTGRES_URL is %s', (value) => {
    vi.stubEnv('POSTGRES_URL', value);
    vi.stubEnv('CODE_PRACTICE_DATABASE_URL', hostedUrl);
    expect(getDatabaseConnection).toThrow('POSTGRES_URL is required');
  });

  it.each([
    'not a URL',
    'postgresql://test:test@127.0.0.1/practice?sslmode=require',
    'postgresql://test:test@localhost/practice?sslmode=require',
    hostedUrl.replace('.neon.tech', '.neon.tech.example.com'),
    hostedUrl.replace('ep-example-pooler.us-east-1.aws', '%2ftmp'),
    hostedUrl.replace('postgresql:', 'https:'),
    hostedUrl.replace('sslmode=require', 'sslmode=disable'),
    hostedUrl.replace('sslmode=require', 'sslmode=prefer'),
    hostedUrl.replace('?sslmode=require&channel_binding=require', ''),
    hostedUrl.replace('test:test@', ''),
    hostedUrl.replace('/practice?', '/?'),
    `${hostedUrl}&host=localhost`,
    `${hostedUrl}&HOST=localhost`,
    `${hostedUrl}&ssl=false`,
    `${hostedUrl}&sslmode=disable`,
    `${hostedUrl}&SSLMODE=disable`,
  ])('rejects invalid, non-Neon, or insecure configuration: %#', (value) => {
    vi.stubEnv('POSTGRES_URL', value);
    expect(getDatabaseConnection).toThrow(/POSTGRES_URL must/);
  });

  it('does not include connection credentials in an error', () => {
    const secret = 'do-not-print-this-password';
    const value = `postgresql://test:${secret}@localhost/practice`;
    expect(() => validateNeonConnectionString(value)).toThrow('POSTGRES_URL must');
    try {
      validateNeonConnectionString(value);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(value);
    }
  });

  it('accepts secure direct test connections without altering their isolated schema', () => {
    const url = new URL(hostedUrl.replace('-pooler.', '.'));
    url.searchParams.set('options', '-csearch_path=cp_test_0123456789abcdef01234567');
    expect(validateNeonConnectionString(url.href).href).toBe(url.href);
  });

  it.each(['verify-ca', 'verify-full'])('accepts sslmode=%s', (mode) => {
    const value = hostedUrl.replace('sslmode=require', `sslmode=${mode}`);
    expect(validateNeonConnectionString(value).href).toBe(value);
  });

  it('pins the Neon connection port without changing credentials or TLS settings', () => {
    vi.stubEnv('PGPORT', '6543');
    makePool(hostedUrl);
    const configured = new URL(poolConfiguration.mock.calls[0][0].connectionString);
    const expected = new URL(hostedUrl);
    expected.port = '5432';
    expect(configured.href).toBe(expected.href);
  });

  it('also refuses non-Neon configuration at the repository boundary', () => {
    expect(() => makePool('postgresql://test:test@localhost/practice')).toThrow(
      'POSTGRES_URL must',
    );
    expect(poolConfiguration).not.toHaveBeenCalled();
  });
});
