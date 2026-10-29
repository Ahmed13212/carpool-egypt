import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { JsonLogger } from './common/json-logger';
import { loadDotEnv, loadEnv } from './config/env';

async function bootstrap() {
  loadDotEnv();
  const env = loadEnv(); // fail fast on bad configuration
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new JsonLogger(),
    bodyParser: false,
  });
  configureApp(app);
  await app.listen(env.PORT);
}
bootstrap().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
