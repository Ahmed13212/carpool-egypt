export interface AuthUser {
  id: string;
  email: string;
  sessionId: string;
  roles: string[];
  permissions: string[];
  emailVerified: boolean;
}
export const hasPermission = (u: Pick<AuthUser, 'permissions'>, p: string) => u.permissions.includes(p);
