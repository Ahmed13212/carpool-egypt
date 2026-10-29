import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, Public, RequirePermissions } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ZodPipe } from '../common/zod.pipe';
import { offsetOf, pageOf, paginationSchema } from '../common/pagination';
import { createTripSchema, updateTripSchema } from './trip.domain';
import { TripsService } from './trips.service';

const uuid = new ZodPipe(z.uuid());
const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);
const radius = z.coerce.number().min(0.5).max(100);

export const searchSchema = paginationSchema
  .extend({
    fromCity: z.string().min(2).max(60).optional(),
    fromLat: lat.optional(),
    fromLng: lng.optional(),
    fromRadiusKm: radius.optional(),
    toCity: z.string().min(2).max(60).optional(),
    toLat: lat.optional(),
    toLng: lng.optional(),
    toRadiusKm: radius.optional(),
    date: z.iso.date().optional(),
    seats: z.coerce.number().int().min(1).max(7).default(1),
    minPriceMinor: z.coerce.number().int().min(0).optional(),
    maxPriceMinor: z.coerce.number().int().min(0).optional(),
    sort: z.enum(['departure', 'price']).default('departure'),
  })
  .refine((v) => v.fromCity || (v.fromLat !== undefined && v.fromLng !== undefined), {
    message: 'Origin required: fromCity or fromLat+fromLng',
  })
  .refine((v) => v.toCity || (v.toLat !== undefined && v.toLng !== undefined), {
    message: 'Destination required: toCity or toLat+toLng',
  });

@Controller()
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Public()
  @Get('trips/search')
  async search(@Query(new ZodPipe(searchSchema)) q: z.infer<typeof searchSchema>) {
    const { total, items } = await this.trips.search({ ...q, limit: q.pageSize, offset: offsetOf(q) });
    return pageOf(items, total, q);
  }

  @RequirePermissions('trip:publish')
  @Post('trips')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(createTripSchema)) body: any) {
    return this.trips.create(u, body);
  }

  @Public()
  @Get('trips/:id')
  get(@Param('id', uuid) id: string) {
    return this.trips.get(id);
  }

  @Patch('trips/:id')
  update(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(updateTripSchema)) body: any,
  ) {
    return this.trips.update(u, id, body);
  }

  @HttpCode(200)
  @Post('trips/:id/cancel')
  cancel(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(z.object({ reason: z.string().trim().max(300).optional() }).default({}))) body: any,
    @Req() req: Request,
  ) {
    return this.trips.cancel(u, id, body.reason, req.ip);
  }

  @Get('me/trips')
  async mine(
    @CurrentUser() u: AuthUser,
    @Query(new ZodPipe(paginationSchema)) q: z.infer<typeof paginationSchema>,
  ) {
    const { total, items } = await this.trips.listForDriver(u.id, q.pageSize, offsetOf(q));
    return pageOf(items, total, q);
  }
}
