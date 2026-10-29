import { z } from 'zod';

export const passwordSchema = z.string().min(10, 'Password must be at least 10 characters').max(128);
export const registerSchema = z.object({
  email: z.email().max(254),
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(120),
  locale: z.enum(['ar', 'en']).default('ar'),
});
export const loginSchema = z.object({ email: z.email().max(254), password: z.string().min(1).max(128) });
export const tokenSchema = z.object({ token: z.string().min(20).max(200) });
export const resetRequestSchema = z.object({ email: z.email().max(254) });
export const resetConfirmSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: passwordSchema,
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;
