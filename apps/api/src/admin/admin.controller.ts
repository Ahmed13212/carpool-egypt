import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { offsetOf, pageOf, paginationSchema } from '../common/pagination';
import { ZodPipe } from '../common/zod.pipe';
import { AdminService, GRANTABLE_ROLES } from './admin.service';

const uuid = new ZodPipe(z.uuid());
const reason = new ZodPipe(z.object({ reason: z.string().trim().min(3).max(300) }));
const optReason = new ZodPipe(z.object({ reason: z.string().trim().max(300).optional() }).default({}));

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @RequirePermissions('users:read')
  @Get('users')
  async users(
    @Query(new ZodPipe(paginationSchema.extend({ q: z.string().max(100).optional() })))
    q: any,
  ) {
    const { total, items } = await this.admin.listUsers(
      q.q,
      q.pageSize,
      offsetOf(q),
    );
    return pageOf(items, total, q);
  }

  // List vehicles waiting for approval
  @RequirePermissions('verification:review')
  @Get('vehicles/pending')
  async pendingVehicles(
    @Query(new ZodPipe(paginationSchema)) q: any,
  ) {
    const { total, items } = await this.admin.listPendingVehicles(
      q.pageSize,
      offsetOf(q),
    );

    return pageOf(items, total, q);
  }

  @RequirePermissions('users:suspend')
  @HttpCode(204)
  @Post('users/:id/suspend')
  suspend(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Body(reason) b: any,
    @Req() req: Request,
  ) {
    return this.admin.suspend(u, id, b.reason, req.ip);
  }

  @RequirePermissions('users:reinstate')
  @HttpCode(204)
  @Post('users/:id/reinstate')
  reinstate(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ) {
    return this.admin.reinstate(u, id, req.ip);
  }

  @RequirePermissions('roles:assign')
  @HttpCode(204)
  @Post('users/:id/roles')
  grant(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(z.object({ role: z.enum(GRANTABLE_ROLES) }))) b: any,
    @Req() req: Request,
  ) {
    return this.admin.grantRole(u, id, b.role, req.ip);
  }

  @RequirePermissions('verification:review')
  @HttpCode(204)
  @Post('drivers/:userId/approve')
  approveDriver(
    @CurrentUser() u: AuthUser,
    @Param('userId', uuid) id: string,
    @Req() req: Request,
  ) {
    return this.admin.reviewDriver(u, id, 'approve', undefined, req.ip);
  }

  @RequirePermissions('verification:review')
  @HttpCode(204)
  @Post('drivers/:userId/reject')
  rejectDriver(
    @CurrentUser() u: AuthUser,
    @Param('userId', uuid) id: string,
    @Body(reason) b: any,
    @Req() req: Request,
  ) {
    return this.admin.reviewDriver(u, id, 'reject', b.reason, req.ip);
  }

  @RequirePermissions('verification:review')
  @HttpCode(204)
  @Post('vehicles/:id/approve')
  approveVehicle(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ) {
    return this.admin.reviewVehicle(u, id, 'approve', req.ip);
  }

  @RequirePermissions('verification:review')
  @HttpCode(204)
  @Post('vehicles/:id/reject')
  rejectVehicle(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Body(optReason) _b: any,
    @Req() req: Request,
  ) {
    return this.admin.reviewVehicle(u, id, 'reject', req.ip);
  }

  @RequirePermissions('audit:read')
  @Get('audit-logs')
  async audit(
    @Query(new ZodPipe(paginationSchema.extend({ action: z.string().max(80).optional() })))
    q: any,
  ) {
    const { total, items } = await this.admin.auditLogs(
      q.pageSize,
      offsetOf(q),
      q.action,
    );
    return pageOf(items, total, q);
  }

  @RequirePermissions('settings:write')
  @Get('settings')
  settings() {
    return this.admin.getSettings();
  }

  @RequirePermissions('settings:write')
  @HttpCode(204)
  @Put('settings/:key')
  setSetting(
    @CurrentUser() u: AuthUser,
    @Param('key') key: string,
    @Body(new ZodPipe(z.object({ value: z.unknown() }))) b: any,
    @Req() req: Request,
  ) {
    return this.admin.updateSetting(u, key, b.value, req.ip);
  }
}
```
