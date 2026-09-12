/** Validate server-only configuration without opening a connection or exposing credentials. */
export function validateNeonConnectionString(value, variableName = 'POSTGRES_URL') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${variableName} is required. Add your Neon connection string to .env.`);
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${variableName} must be a valid Neon PostgreSQL connection string.`);
  }

  const secureModes = new Set(['require', 'verify-ca', 'verify-full']);
  const overrides = ['host', 'hostaddr', 'port', 'user', 'password', 'database', 'dbname', 'ssl'];
  const queryKeys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
  const neonHostname = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+neon\.tech$/;
  if (
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !neonHostname.test(url.hostname.toLowerCase()) ||
    (url.port && url.port !== '5432') ||
    !url.username ||
    !url.password ||
    url.pathname.length <= 1 ||
    url.hash ||
    !secureModes.has(url.searchParams.get('sslmode')) ||
    new Set(queryKeys).size !== queryKeys.length ||
    overrides.some((key) => queryKeys.includes(key))
  ) {
    throw new Error(`${variableName} must use a Neon PostgreSQL endpoint with SSL enabled.`);
  }
  return url;
}

export function getDatabaseConnection(environment = process.env) {
  const connectionString = environment.POSTGRES_URL;
  validateNeonConnectionString(connectionString);
  return { connectionString: connectionString.trim() };
}
