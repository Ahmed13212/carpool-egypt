import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from '../common/app-error';
import { ZodPipe } from '../common/zod.pipe';
import { ENV, Env } from '../config/env';
import { CurrentUser, Public, RateLimit } from './auth.decorators';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  resetConfirmSchema,
  resetRequestSchema,
  tokenSchema,
} from './auth.schemas';
import { AuthService, Tokens } from './auth.service';
import type { AuthUser } from './auth.types';
import { UsersService } from '../users/users.service';

const COOKIE = 'refresh_token';
const COOKIE_PATH = '/api/v1/auth';

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private meta = (req: Request) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

  private setRefreshCookie(res: Response, t: Tokens) {
    res.cookie(COOKIE, t.refreshToken, {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: COOKIE_PATH,
      expires: t.refreshExpiresAt,
    });
  }

  /** CSRF defence for cookie-authenticated endpoints: SameSite=Strict + a custom header browsers cannot send cross-site without CORS preflight. */
  private requireCsrfHeader(req: Request) {
    if (req.headers['x-requested-with'] !== 'fetch') {
      throw new AppError(403, 'csrf_check_failed', 'Missing X-Requested-With header');
    }
  }

  @Public()
  @RateLimit()
  @Post('register')
  async register(@Body(new ZodPipe(registerSchema)) body: any) {
    return this.auth.register(body);
  }

  @Public()
  @RateLimit()
  @HttpCode(200)
  @Post('login')
  async login(
    @Body(new ZodPipe(loginSchema)) body: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { tokens, userId } = await this.auth.login(body.email, body.password, this.meta(req));
    this.setRefreshCookie(res, tokens);
    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
      user: await this.users.getMe(userId),
    };
  }

  @Public()
  @RateLimit({ limit: 30 })
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.requireCsrfHeader(req);
    const token = readCookie(req, COOKIE);
    if (!token) throw new AppError(401, 'invalid_refresh_token', 'Invalid refresh token');
    const tokens = await this.auth.refresh(token, this.meta(req));
    this.setRefreshCookie(res, tokens);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.requireCsrfHeader(req);
    await this.auth.logout(readCookie(req, COOKIE));
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
  }

  @Public()
  @RateLimit()
  @HttpCode(204)
  @Post('verify-email')
  async verifyEmail(@Body(new ZodPipe(tokenSchema)) body: any) {
    await this.auth.verifyEmail(body.token);
  }

  @Public()
  @RateLimit()
  @HttpCode(202)
  @Post('password-reset')
  async requestReset(@Body(new ZodPipe(resetRequestSchema)) body: any) {
    await this.auth.requestPasswordReset(body.email);
    return { status: 'accepted' };
  }

  @Public()
  @RateLimit()
  @HttpCode(204)
  @Post('password-reset/confirm')
  async confirmReset(@Body(new ZodPipe(resetConfirmSchema)) body: any) {
    await this.auth.resetPassword(body.token, body.newPassword);
  }

  @RateLimit()
  @HttpCode(204)
  @Post('change-password')
  async changePassword(@CurrentUser() user: AuthUser, @Body(new ZodPipe(changePasswordSchema)) body: any) {
    await this.auth.changePassword(user.id, body.currentPassword, body.newPassword);
  }
}
