import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { ENV, Env } from './config/env';

/** Shared HTTP configuration used by main.ts and by tests, so tests exercise the real pipeline. */
export function configureApp(app: NestExpressApplication) {
  const env = app.get<Env>(ENV);
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  app.use(helmet());
  app.useBodyParser('json', { limit: '100kb' });
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const origins = env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length) app.enableCors({ origin: origins, credentials: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
}
