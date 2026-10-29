import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { offsetOf, pageOf, paginationSchema } from '../common/pagination';
import { ZodPipe } from '../common/zod.pipe';
import { BookingsService, createBookingSchema, idempotencyKeySchema } from './bookings.service';

const uuid = new ZodPipe(z.uuid());
const reasonBody = new ZodPipe(z.object({ reason: z.string().trim().max(300).optional() }).default({}));

@Controller()
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @RequirePermissions('booking:create')
  @Post('trips/:id/bookings')
  async create(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) tripId: string,
    @Body(new ZodPipe(createBookingSchema)) body: any,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = idempotencyKeySchema.safeParse(key);
    if (!parsed.success)
      throw new AppError(
        400,
        'idempotency_key_required',
        'A valid Idempotency-Key header (8-128 chars: A-Z a-z 0-9 . _ : -) is required',
      );
    const { booking, replayed } = await this.bookings.create(u, tripId, body, parsed.data);
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    return booking;
  }

  @Get('me/bookings')
  async mine(
    @CurrentUser() u: AuthUser,
    @Query(new ZodPipe(paginationSchema)) q: z.infer<typeof paginationSchema>,
  ) {
    const { total, items } = await this.bookings.listMine(u, q.pageSize, offsetOf(q));
    return pageOf(items, total, q);
  }

  @Get('trips/:id/bookings')
  async forTrip(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Query(new ZodPipe(paginationSchema)) q: z.infer<typeof paginationSchema>,
  ) {
    const { total, items } = await this.bookings.listForTrip(u, id, q.pageSize, offsetOf(q));
    return pageOf(items, total, q);
  }

  @Get('bookings/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.bookings.get(u, id);
  }

  @HttpCode(200)
  @Post('bookings/:id/confirm')
  confirm(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.bookings.decide(u, id, 'confirm');
  }

  @HttpCode(200)
  @Post('bookings/:id/reject')
  reject(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(reasonBody) body: any) {
    return this.bookings.decide(u, id, 'reject', body.reason);
  }

  @HttpCode(200)
  @Post('bookings/:id/cancel')
  cancel(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(reasonBody) body: any) {
    return this.bookings.cancel(u, id, body.reason);
  }
}
