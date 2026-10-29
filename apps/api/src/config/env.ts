import { existsSync } from 'node:fs';
import { z } from 'zod';

export const ENV = Symbol('ENV');

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: bool,
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  PASSWORD_SCRYPT_N: z.coerce.number().int().min(1024).default(32768),
});

export type Env = z.infer<typeof schema>;

/** Validates configuration at startup. Error messages list variable names only, never values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return parsed.data;
}

/** Loads ./.env (relative to the working directory) if present. Real environment variables always win. */
export function loadDotEnv(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
}
