process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RATE_LIMIT_AUTH_PER_MINUTE = '3';
import request from 'supertest';
import { startHarness, uniqueEmail, Harness } from '../helpers';

describe('rate limiting on authentication endpoints', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('returns 429 after the configured number of login attempts', async () => {
    const email = uniqueEmail();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push(
        (await request(h.http).post('/api/v1/auth/login').send({ email, password: 'wrong-password-1' }))
          .status,
      );
    }
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });
});
