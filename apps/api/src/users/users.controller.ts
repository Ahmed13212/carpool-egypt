import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ZodPipe } from '../common/zod.pipe';
import { UsersService, updateMeSchema } from './users.service';

@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get() me(@CurrentUser() u: AuthUser) {
    return this.users.getMe(u.id);
  }
  @Patch() update(@CurrentUser() u: AuthUser, @Body(new ZodPipe(updateMeSchema)) body: any) {
    return this.users.updateMe(u.id, body);
  }
}
