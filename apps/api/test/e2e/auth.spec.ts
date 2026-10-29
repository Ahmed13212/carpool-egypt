import { createHmac } from 'node:crypto';
import request from 'supertest';
import { bearer, login, newStaff, newUser, PASSWORD, startHarness, uniqueEmail, Harness } from '../helpers';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const cookieHeader = (cookies: string[]) => cookies.map((c) => c.split(';')[0]).join('; ');
const api = '/api/v1';

describe('authentication and sessions (HTTP)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('health and readiness endpoints', async () => {
    await request(h.http).get('/health').expect(200, { status: 'ok' });
    await request(h.http).get('/ready').expect(200, { status: 'ready' });
  });

  it('registration validates input, rejects duplicates, never returns the password or hash', async () => {
    const email = uniqueEmail();
    await request(h.http)
      .post(`${api}/auth/register`)
      .send({ email, password: 'short', fullName: 'A' })
      .expect(400)
      .expect((r) => {
        expect(r.body.error.code).toBe('validation_failed');
      });
    const ok = await request(h.http)
      .post(`${api}/auth/register`)
      .send({ email, password: PASSWORD, fullName: 'Sara Hassan' })
      .expect(201);
    expect(JSON.stringify(ok.body)).not.toMatch(/password|hash/i);
    await request(h.http)
      .post(`${api}/auth/register`)
      .send({ email: email.toUpperCase(), password: PASSWORD, fullName: 'Sara Hassan' })
      .expect(409);
    const stored = await h.pool.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    expect(stored.rows[0].password_hash.startsWith('scrypt$')).toBe(true);
    expect(stored.rows[0].password_hash).not.toContain(PASSWORD);
  });

  it('e-mail verification token is single use and stored hashed', async () => {
    const email = uniqueEmail();
    await request(h.http)
      .post(`${api}/auth/register`)
      .send({ email, password: PASSWORD, fullName: 'Omar Ali' })
      .expect(201);
    const token = h.mailer.lastTokenFor(email, 'email_verification')!;
    const raw = await h.pool.query(
      `SELECT token_hash FROM auth_tokens WHERE type='email_verification' AND token_hash = $1`,
      [token],
    );
    expect(raw.rowCount).toBe(0); // the raw token is never stored
    await request(h.http).post(`${api}/auth/verify-email`).send({ token }).expect(204);
    await request(h.http).post(`${api}/auth/verify-email`).send({ token }).expect(400);
    const { token: access } = await login(h, email);
    expect((await request(h.http).get(`${api}/me`).set(bearer(access)).expect(200)).body.emailVerified).toBe(
      true,
    );
  });

  it('login failures are indistinguishable between unknown e-mail and wrong password', async () => {
    const u = await newUser(h);
    const wrong = await request(h.http)
      .post(`${api}/auth/login`)
      .send({ email: u.email, password: 'wrong-password-123' })
      .expect(401);
    const unknown = await request(h.http)
      .post(`${api}/auth/login`)
      .send({ email: uniqueEmail(), password: 'wrong-password-123' })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('rejects missing, malformed, wrongly-signed and alg=none tokens', async () => {
    const u = await newUser(h);
    await request(h.http).get(`${api}/me`).expect(401);
    await request(h.http).get(`${api}/me`).set(bearer('not.a.jwt')).expect(401);
    const header = b64({ alg: 'HS256', typ: 'JWT' });
    const payload = b64({
      sub: u.id,
      sid: '00000000-0000-0000-0000-000000000000',
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const forged = `${header}.${payload}.${createHmac('sha256', 'attacker-guess').update(`${header}.${payload}`).digest('base64url')}`;
    await request(h.http).get(`${api}/me`).set(bearer(forged)).expect(401);
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${payload}.`;
    await request(h.http).get(`${api}/me`).set(bearer(none)).expect(401);
  });

  it('refresh cookie is HttpOnly + SameSite=Strict + scoped; refresh needs the CSRF header; rotation works', async () => {
    const u = await newUser(h);
    const c = u.cookies.join(';');
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Strict/i);
    expect(c).toMatch(/Path=\/api\/v1\/auth/);
    await request(h.http).post(`${api}/auth/refresh`).set('Cookie', cookieHeader(u.cookies)).expect(403);
    const r1 = await request(h.http)
      .post(`${api}/auth/refresh`)
      .set('Cookie', cookieHeader(u.cookies))
      .set('X-Requested-With', 'fetch')
      .expect(200);
    expect(r1.body.accessToken).toBeDefined();
    await request(h.http).get(`${api}/me`).set(bearer(r1.body.accessToken)).expect(200);
    await request(h.http).get(`${api}/me`).set(bearer(u.token)).expect(401); // old session was rotated out
  });

  it('replaying a rotated refresh token revokes every session of the user (theft detection)', async () => {
    const u = await newUser(h);
    const first = cookieHeader(u.cookies);
    const r1 = await request(h.http)
      .post(`${api}/auth/refresh`)
      .set('Cookie', first)
      .set('X-Requested-With', 'fetch')
      .expect(200);
    await request(h.http)
      .post(`${api}/auth/refresh`)
      .set('Cookie', first)
      .set('X-Requested-With', 'fetch')
      .expect(401); // replay
    await request(h.http).get(`${api}/me`).set(bearer(r1.body.accessToken)).expect(401); // legit session killed too
    const audit = await h.pool.query(
      `SELECT 1 FROM audit_logs WHERE action='auth.refresh_token_reuse_detected' AND target_id=$1`,
      [u.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('logout revokes the session', async () => {
    const u = await newUser(h);
    await request(h.http)
      .post(`${api}/auth/logout`)
      .set('Cookie', cookieHeader(u.cookies))
      .set('X-Requested-With', 'fetch')
      .expect(204);
    await request(h.http)
      .post(`${api}/auth/refresh`)
      .set('Cookie', cookieHeader(u.cookies))
      .set('X-Requested-With', 'fetch')
      .expect(401);
    await request(h.http).get(`${api}/me`).set(bearer(u.token)).expect(401);
  });

  it('password reset: no enumeration, single-use token, revokes sessions, old password stops working', async () => {
    const u = await newUser(h);
    await request(h.http).post(`${api}/auth/password-reset`).send({ email: uniqueEmail() }).expect(202); // unknown e-mail: same answer
    await request(h.http).post(`${api}/auth/password-reset`).send({ email: u.email }).expect(202);
    const token = h.mailer.lastTokenFor(u.email, 'password_reset')!;
    await request(h.http)
      .post(`${api}/auth/password-reset/confirm`)
      .send({ token, newPassword: 'a-brand-new-passphrase' })
      .expect(204);
    await request(h.http)
      .post(`${api}/auth/password-reset/confirm`)
      .send({ token, newPassword: 'another-new-passphrase' })
      .expect(400);
    await request(h.http).get(`${api}/me`).set(bearer(u.token)).expect(401);
    await request(h.http).post(`${api}/auth/login`).send({ email: u.email, password: PASSWORD }).expect(401);
    await request(h.http)
      .post(`${api}/auth/login`)
      .send({ email: u.email, password: 'a-brand-new-passphrase' })
      .expect(200);
  });

  it('change-password needs the current password and revokes sessions', async () => {
    const u = await newUser(h);
    await request(h.http)
      .post(`${api}/auth/change-password`)
      .set(bearer(u.token))
      .send({ currentPassword: 'nope-nope-nope', newPassword: 'x'.repeat(12) })
      .expect(403);
    await request(h.http)
      .post(`${api}/auth/change-password`)
      .set(bearer(u.token))
      .send({ currentPassword: PASSWORD, newPassword: 'x'.repeat(12) })
      .expect(204);
    await request(h.http).get(`${api}/me`).set(bearer(u.token)).expect(401);
  });

  it('suspension takes effect immediately on existing tokens; reinstatement restores login; both are audited', async () => {
    const admin = await newStaff(h, 'administrator');
    const u = await newUser(h);
    await request(h.http)
      .post(`${api}/admin/users/${u.id}/suspend`)
      .set(bearer(admin.token))
      .send({ reason: 'abuse report #1' })
      .expect(204);
    await request(h.http).get(`${api}/me`).set(bearer(u.token)).expect(401);
    await request(h.http)
      .post(`${api}/auth/login`)
      .send({ email: u.email, password: PASSWORD })
      .expect(403)
      .expect((r) => expect(r.body.error.code).toBe('account_suspended'));
    await request(h.http).post(`${api}/admin/users/${u.id}/reinstate`).set(bearer(admin.token)).expect(204);
    await login(h, u.email);
    const logs = await request(h.http)
      .get(`${api}/admin/audit-logs?pageSize=50`)
      .set(bearer(admin.token))
      .expect(200);
    const mine = logs.body.items.filter((l: any) => l.targetId === u.id).map((l: any) => l.action);
    expect(mine).toEqual(expect.arrayContaining(['user.suspended', 'user.reinstated']));
  });

  it('profile update validates and persists; unknown JSON fields cannot escalate roles', async () => {
    const u = await newUser(h);
    const r = await request(h.http)
      .patch(`${api}/me`)
      .set(bearer(u.token))
      .send({ fullName: 'Nour Samir', phone: '+201001234567', roles: ['super_administrator'] })
      .expect(200);
    expect(r.body).toMatchObject({ fullName: 'Nour Samir', phone: '+201001234567' });
    expect(r.body.roles).toEqual(['passenger']);
    await request(h.http).patch(`${api}/me`).set(bearer(u.token)).send({ phone: 'abc' }).expect(400);
    await request(h.http).patch(`${api}/me`).set(bearer(u.token)).send({}).expect(400);
  });

  it('errors never leak internals; oversized and malformed bodies are handled', async () => {
    const big = await request(h.http)
      .post(`${api}/auth/login`)
      .send({ email: 'a@b.co', password: 'x'.repeat(200_000) });
    expect(big.status).toBe(413);
    const bad = await request(h.http)
      .post(`${api}/auth/login`)
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(bad.status).toBe(400);
    const bogus = await request(h.http).get(`${api}/trips/not-a-uuid`);
    expect(bogus.status).toBe(400);
    expect(JSON.stringify(bogus.body)).not.toMatch(/at \w+|node_modules|SELECT|pg/);
  });

  it('sets security headers and hides the framework', async () => {
    const r = await request(h.http).get('/health');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['strict-transport-security']).toBeDefined();
  });
});
