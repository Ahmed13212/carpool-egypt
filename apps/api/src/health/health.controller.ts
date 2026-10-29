import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/auth.decorators';
import { DatabaseService } from '../database/database.service';

@Controller()
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      res.status(503);
      return { status: 'not_ready' };
    }
  }
}
