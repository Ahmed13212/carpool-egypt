// Runs in every test file's environment before modules load. Test-only values; no production secrets.
process.env.NODE_ENV = 'test';
if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'Set TEST_DATABASE_URL to a DISPOSABLE Postgres+PostGIS database (app tables are dropped on every run).',
  );
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_ACCESS_SECRET = 'test-only-secret-not-for-production-0123456789';
process.env.PASSWORD_SCRYPT_N = '1024'; // fast hashing for tests only (production default is 32768)
process.env.RATE_LIMIT_ENABLED = 'false';
