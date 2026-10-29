import { PasswordService } from '../../src/auth/password.service';
import { loadEnv } from '../../src/config/env';

describe('PasswordService', () => {
  const svc = new PasswordService({ PASSWORD_SCRYPT_N: 1024 });
  it('verifies the right password and rejects the wrong one', async () => {
    const h = await svc.hash('a-long-passphrase');
    expect(h.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(await svc.verify('a-long-passphrase', h)).toBe(true);
    expect(await svc.verify('a-long-passphrasE', h)).toBe(false);
  });
  it('salts: same password hashes differently', async () => {
    expect(await svc.hash('same-password-1')).not.toEqual(await svc.hash('same-password-1'));
  });
  it('rejects malformed stored hashes without throwing', async () => {
    expect(await svc.verify('x', 'plaintext')).toBe(false);
    expect(await svc.verify('x', 'bcrypt$1$2$3$4$5')).toBe(false);
  });
});

describe('loadEnv', () => {
  const base = { DATABASE_URL: 'postgres://u:p@h/db', JWT_ACCESS_SECRET: 'x'.repeat(40) };
  it('applies defaults', () => {
    const e = loadEnv(base as any);
    expect(e.PORT).toBe(4000);
    expect(e.RATE_LIMIT_ENABLED).toBe(true);
  });
  it('fails fast on a short secret and does not echo the secret value', () => {
    expect.assertions(2);
    try {
      loadEnv({ ...base, JWT_ACCESS_SECRET: 'short-secret-value' } as any);
    } catch (e: any) {
      expect(e.message).toContain('JWT_ACCESS_SECRET');
      expect(e.message).not.toContain('short-secret-value');
    }
  });
});
