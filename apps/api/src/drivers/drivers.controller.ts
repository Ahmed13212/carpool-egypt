import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ZodPipe } from '../common/zod.pipe';
import { createVehicleSchema, DriversService } from './drivers.service';

@Controller()
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @HttpCode(200)
  @Post('drivers/apply')
  apply(@CurrentUser() u: AuthUser) {
    return this.drivers.apply(u);
  }

  @Get('me/driver')
  status(@CurrentUser() u: AuthUser) {
    return this.drivers.status(u.id);
  }

  @RequirePermissions('vehicle:manage')
  @Post('vehicles')
  createVehicle(@CurrentUser() u: AuthUser, @Body(new ZodPipe(createVehicleSchema)) body: any) {
    return this.drivers.createVehicle(u, body);
  }

  @RequirePermissions('vehicle:manage')
  @Get('me/vehicles')
  vehicles(@CurrentUser() u: AuthUser) {
    return this.drivers.listVehicles(u);
  }
}
