import express, { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { HttpError, ORGS, OUTPUTS, PURPOSES, N, Store } from './core';

type User = { role: 'admin' | 'farmer' | 'requester'; actor: string; farmerId?: number; org?: string };

/** DEMO-ONLY authentication: static bearer tokens. Not production auth. */
function resolve(token: string): User | null {
  if (token === (process.env.DEMO_ADMIN_TOKEN || 'demo-admin')) return { role: 'admin', actor: 'FPO Admin' };
  let m = /^demo-farmer-(\d+)$/.exec(token);
  if (m && +m[1] >= 1 && +m[1] <= N) return { role: 'farmer', actor: `Farmer #${m[1]}`, farmerId: +m[1] };
  m = /^demo-requester-([1-3])$/.exec(token);
  if (m) return { role: 'requester', actor: ORGS[+m[1] - 1], org: ORGS[+m[1] - 1] };
  return null;
}
const DS = [
  { id: 'ds1', name: 'Crop pattern and yield', level: 'individual', sensitivity: 'Medium' },
  { id: 'ds2', name: 'Soil measurements', level: 'individual', sensitivity: 'High' },
  { id: 'ds3', name: 'Irrigation usage', level: 'individual', sensitivity: 'Medium' },
  { id: 'ds4', name: 'Market price trends', level: 'aggregate', sensitivity: 'Low' },
];

export function createApp(s: Store) {
  const app = express();
  app.use(express.json({ limit: '20kb' }));
  const auth = (...roles: User['role'][]) => (req: Request, _res: Response, next: NextFunction) => {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    const u = resolve(t);
    if (!u) throw new HttpError(401, 'Missing or invalid demo token');
    if (!roles.includes(u.role)) throw new HttpError(403, `Role "${u.role}" is not allowed to do this`);
    (req as any).user = u; next();
  };
  const U = (req: Request) => (req as any).user as User;

  app.get('/api/health', (_q, r) => r.json({ ok: true, data: 'synthetic' }));
  app.get('/api/overview', auth('admin', 'farmer', 'requester'), (_q, r) => {
    s.refreshExpiry();
    const c = (sql: string) => (s.db.prepare(sql).get() as any).c;
    r.json({ members: N, activePolicy: s.active().v, pendingRequests: c("select count(*) c from requests where status='Pending'"), releases: c("select count(*) c from audit where action='data released'"), chain: s.verifyChain() });
  });
  // Metadata only. No endpoint in this API returns individual farmer rows.
  app.get('/api/registry', auth('admin', 'farmer'), (_q, r) => r.json({ datasets: DS, purposes: s.active().purposes }));
  app.get('/api/policies', auth('admin', 'farmer'), (_q, r) => r.json((s.db.prepare('select v from policies order by v desc').all() as any[]).map(x => ({ ...s.pol(x.v), tally: s.tally(x.v), eligible: N }))));
  app.post('/api/policies', auth('admin'), (q, r) => {
    const b = z.object({ title: z.string().min(3).max(120), purposes: z.array(z.enum(PURPOSES)).min(1), k: z.number().int().min(3).max(50), maxDays: z.number().int().min(1).max(365), thr: z.number().min(0.5).max(1) }).parse(q.body);
    r.status(201).json(s.propose(b));
  });
  app.post('/api/policies/:v/vote', auth('farmer'), (q, r) => {
    const b = z.object({ choice: z.enum(['for', 'against', 'abstain']) }).parse(q.body);
    r.json(s.castVote(Number(q.params.v), U(q).farmerId!, b.choice));
  });
  app.get('/api/requests', auth('admin', 'farmer', 'requester'), (q, r) => {
    s.refreshExpiry();
    const u = U(q); let rows = s.db.prepare('select * from requests order by at desc').all() as any[];
    if (u.role === 'requester') rows = rows.filter(x => x.org === u.org);
    if (u.role === 'farmer') rows = rows.map(({ contact, ...x }) => x);
    r.json(rows);
  });
  app.post('/api/requests', auth('requester'), (q, r) => {
    const b = z.object({ purpose: z.enum(PURPOSES), out: z.enum(Object.keys(OUTPUTS) as [string, ...string[]]), days: z.number().int().min(1).max(365), contact: z.string().email() }).parse(q.body);
    r.status(201).json(s.submit(U(q).org!, b));
  });
  app.post('/api/requests/:id/approve', auth('admin'), (q, r) => r.json(s.review(q.params.id, 'approve')));
  app.post('/api/requests/:id/reject', auth('admin'), (q, r) => r.json(s.review(q.params.id, 'reject')));
  app.post('/api/requests/:id/revoke', auth('admin'), (q, r) => r.json(s.revoke(q.params.id)));
  app.post('/api/requests/:id/release', auth('requester'), (q, r) => r.json(s.release(q.params.id, U(q).org!)));
  app.get('/api/requests/:id/raw', auth('requester'), (q, _r) => s.refuseRaw(q.params.id, U(q).org!));
  app.get('/api/audit', auth('admin', 'farmer'), (_q, r) => r.json(s.db.prepare('select * from audit order by i desc').all()));
  app.get('/api/audit/verify', auth('admin', 'farmer'), (_q, r) => r.json({ ...s.verifyChain(), note: 'Local SHA-256 hash chain: tamper-evident only, not a production immutable ledger.' }));
  app.get('/api/benefits', auth('admin', 'farmer', 'requester'), (_q, r) => r.json({ simulated: true, entries: s.db.prepare('select * from ledger order by ts').all() }));
  app.post('/api/admin/advance', auth('admin'), (q, r) => { const b = z.object({ days: z.number().int().min(1).max(365) }).parse(q.body); s.advance(b.days); r.json({ now: s.now() }); });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((e: any, _q: Request, res: Response, _n: NextFunction) => {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    if (e instanceof ZodError) return res.status(400).json({ error: 'Invalid input', issues: e.issues });
    console.error(e); res.status(500).json({ error: 'Internal error' });
  });
  return app;
}
