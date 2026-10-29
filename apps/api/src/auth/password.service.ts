import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ENV, Env } from '../config/env';

const scryptAsync = (
  pw: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** scrypt (RFC 7914) via node:crypto. Hash format: scrypt$N$r$p$salt$key (parameters travel with the hash). */
@Injectable()
export class PasswordService {
  constructor(@Inject(ENV) private readonly env: Pick<Env, 'PASSWORD_SCRYPT_N'>) {}

  async hash(password: string): Promise<string> {
    const N = this.env.PASSWORD_SCRYPT_N,
      r = 8,
      p = 1;
    const salt = randomBytes(16);
    const key = await scryptAsync(password, salt, 64, { N, r, p, maxmem: 256 * N * r });
    return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]),
      r = Number(parts[2]),
      p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const actual = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: 256 * N * r });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
