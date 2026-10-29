import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthUser } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const PERMISSIONS = 'permissions';
export const RATE_LIMIT = 'rateLimit';

export const Public = () => SetMetadata(IS_PUBLIC, true);
/** All listed permissions are required. Enforced server-side by AuthGuard. */
export const RequirePermissions = (...perms: string[]) => SetMetadata(PERMISSIONS, perms);
export const RateLimit = (opts: { limit?: number; windowSec?: number } = {}) => SetMetadata(RATE_LIMIT, opts);
export const CurrentUser = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
