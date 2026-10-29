import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createStore, HttpError, ORGS, Store } from '../src/core';
import { createApp } from '../src/app';

let s: Store;
const T = ORGS[0];
const newReq = (over: Partial<{ purpose: string; out: string; days: number }> = {}) => s.submit(T, { purpose: 'Academic research', out: 'yield_village', days: 30, contact: 'a@b.example', ...over });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as HttpError).status; } return 0; };
beforeEach(() => { s = createStore(':memory:'); });

describe('voting', () => {
  it('blocks duplicate votes', () => {
    s.castVote(2, 7, 'for');
    expect(code(() => s.castVote(2, 7, 'against'))).toBe(409);
  });
  it('activates a policy only when quorum and threshold are met', () => {
    s.castVote(2, 7, 'for');
    expect(s.pol(2).status).toBe('proposed'); // 59 of 60 quorum
    s.castVote(2, 8, 'for');
    expect(s.pol(2).status).toBe('active');
    expect(s.pol(1).status).toBe('superseded');
  });
  it('does not activate when approval is below threshold', () => {
    for (let i = 1; i <= 19; i++) s.castVote(2, i, 'against'); // quorum met, approval too low
    expect(s.pol(2).status).toBe('proposed');
  });
});

describe('authorization and purpose', () => {
  it('pending request cannot release data', () => {
    expect(code(() => s.release('R-102', T))).toBe(403);
  });
  it('incompatible purpose is rejected with a reason', () => {
    const r = s.review('R-103', 'approve');
    expect(r.status).toBe('Rejected');
    expect(r.reason).toContain('not permitted');
  });
  it('government purpose is rejected until policy v2 is active, then approved', () => {
    const a = newReq({ purpose: 'Government planning' });
    expect(s.review(a.id, 'approve').status).toBe('Rejected');
    s.castVote(2, 7, 'for'); s.castVote(2, 8, 'for');
    const b = newReq({ purpose: 'Government planning' });
    expect(s.review(b.id, 'approve').status).toBe('Approved');
  });
  it('another organization cannot release a request', () => {
    s.review('R-102', 'approve');
    expect(code(() => s.release('R-102', ORGS[1]))).toBe(403);
  });
});

describe('expiry, revocation and budget', () => {
  it('expired approval cannot release', () => {
    const r = newReq(); s.review(r.id, 'approve');
    s.advance(31);
    expect(code(() => s.release(r.id, T))).toBe(403);
    expect(s.getReq(r.id).status).toBe('Expired');
  });
  it('revoked approval cannot release', () => {
    const r = newReq(); s.review(r.id, 'approve'); s.revoke(r.id);
    expect(code(() => s.release(r.id, T))).toBe(403);
  });
  it('release budget limits repeated queries', () => {
    const r = newReq(); s.review(r.id, 'approve');
    for (let i = 0; i < 3; i++) s.release(r.id, T);
    expect(code(() => s.release(r.id, T))).toBe(403);
  });
  it('rejects durations above the policy maximum', () => {
    const r = newReq({ days: 90 });
    expect(s.review(r.id, 'approve').status).toBe('Rejected');
  });
});

describe('privacy', () => {
  it('suppresses groups below the minimum size and exposes no individual fields', () => {
    const r = newReq(); s.review(r.id, 'approve');
    const out = s.release(r.id, T);
    const pip = out.rows.find(x => x.label === 'Pipraich')!, nau = out.rows.find(x => x.label === 'Nautanwa')!;
    expect(pip.suppressed).toBe(true); expect(pip.value).toBeUndefined();
    expect(nau.suppressed).toBe(true); // 9 < 10
    expect(out.rows.find(x => x.label === 'Rampur')!.suppressed).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/"id"|"ph"|farmer/i);
  });
});

describe('audit', () => {
  it('records decisions and denials, and the chain verifies', () => {
    const r = newReq(); s.review(r.id, 'approve'); s.release(r.id, T); s.revoke(r.id); code(() => s.release(r.id, T));
    const actions = (s.db.prepare('select action from audit').all() as any[]).map(x => x.action);
    for (const a of ['request approved', 'data released', 'access revoked', 'access denied']) expect(actions).toContain(a);
    expect(s.verifyChain().valid).toBe(true);
  });
  it('detects tampering', () => {
    s.db.prepare("update audit set decision='Denied' where i=4").run();
    expect(s.verifyChain()).toEqual({ valid: false, brokenAt: 4 });
  });
});

describe('HTTP API', () => {
  it('requires a token', async () => { expect((await request(createApp(s)).get('/api/audit')).status).toBe(401); });
  it('requester cannot read the registry, audit or raw records', async () => {
    const app = createApp(s), h = { Authorization: 'Bearer demo-requester-1' };
    expect((await request(app).get('/api/registry').set(h)).status).toBe(403);
    expect((await request(app).get('/api/audit').set(h)).status).toBe(403);
    expect((await request(app).get('/api/requests/R-102/raw').set(h)).status).toBe(403);
  });
  it('end-to-end: approve then release returns group-level rows', async () => {
    const app = createApp(s);
    await request(app).post('/api/requests/R-102/approve').set('Authorization', 'Bearer demo-admin').expect(200);
    const res = await request(app).post('/api/requests/R-102/release').set('Authorization', 'Bearer demo-requester-1').expect(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
  });
});
