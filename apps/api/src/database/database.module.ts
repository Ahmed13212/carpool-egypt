import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from '../config/env';
import { DatabaseService } from './database.service';

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }, DatabaseService],
  exports: [ENV, DatabaseService],
})
export class DatabaseModule {}
