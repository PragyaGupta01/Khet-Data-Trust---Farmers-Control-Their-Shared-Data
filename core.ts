import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export const D = 864e5, T0 = Date.UTC(2026, 9, 29, 9, 0), N = 120;
export const PURPOSES = ['Academic research', 'Government planning', 'Commercial product', 'Data resale'] as const;
export const OUTPUTS: Record<string, { label: string; ds: string }> = {
  yield_crop: { label: 'Average yield by crop', ds: 'ds1' },
  yield_village: { label: 'Average yield by village', ds: 'ds1' },
  crop_dist: { label: 'Crop distribution', ds: 'ds1' },
  irr_village: { label: 'Irrigation mix by village', ds: 'ds3' },
};
export const ORGS = ['Terai Agri Research Institute (demo)', 'UP Agriculture Dept. Planning Cell (demo)', 'AgriMart Inputs Pvt Ltd (demo)'];
export const MAX_RELEASES = 3;

export class HttpError extends Error { constructor(public status: number, m: string) { super(m); } }

function rng(s: number) { return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const VIL: [string, number][] = [['Rampur', 34], ['Salempur', 28], ['Chiraiya', 26], ['Belghat', 19], ['Nautanwa', 9], ['Pipraich', 4]];
const CR: [string, number][] = [['Wheat', 18], ['Rice', 20], ['Sugarcane', 300], ['Maize', 22], ['Mustard', 7]];
const IR = ['Tubewell', 'Canal', 'Rain-fed'];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const SCHEMA = `
create table if not exists meta(k text primary key, v text);
create table if not exists farmers(id integer primary key, village text, crop text, yield real, irr text, ph real);
create table if not exists policies(v integer primary key, title text, status text, purposes text, k integer, max_days integer, thr real, quorum real, at integer);
create table if not exists votes(policy_v integer, farmer_id integer, choice text check(choice in ('for','against','abstain')), primary key(policy_v, farmer_id));
create table if not exists requests(id text primary key, org text, purpose text, ds text, out text, days integer, contact text, status text, at integer, apv integer, exp integer, reason text, rel integer default 0);
create table if not exists audit(i integer primary key, ts integer, actor text, action text, ds text, purpose text, decision text, pv text, detail text, prev text, hash text);
create table if not exists ledger(ts integer, d text, a integer);`;

export function createStore(path = ':memory:') {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  const now = () => Number((db.prepare("select v from meta where k='now'").get() as any)?.v ?? T0);
  const eh = (prev: string, a: unknown[]) => sha(prev + JSON.stringify(a));

  function log(actor: string, action: string, ds?: string | null, purpose?: string | null, decision?: string, pv?: number | string, detail = '', ts = now()) {
    const last = db.prepare('select hash from audit order by i desc limit 1').get() as any;
    const prev = last ? last.hash : 'genesis';
    const i = (db.prepare('select count(*) c from audit').get() as any).c;
    const row = [i, ts, actor, action, ds || '-', purpose || '-', decision || '-', String(pv ?? '-'), detail];
    db.prepare('insert into audit values (?,?,?,?,?,?,?,?,?,?,?)').run(...row, prev, eh(prev, row));
  }
  const pol = (v: number): any => { const p: any = db.prepare('select * from policies where v=?').get(v); if (p) p.purposes = JSON.parse(p.purposes); return p; };
  const active = () => { const p: any = db.prepare("select v from policies where status='active'").get(); return pol(p.v); };
  const tally = (v: number) => { const o: Record<string, number> = { for: 0, against: 0, abstain: 0 }; (db.prepare('select choice, count(*) c from votes where policy_v=? group by choice').all(v) as any[]).forEach(r => o[r.choice] = r.c); return o; };

  function evalPolicy(v: number) {
    const p = pol(v); if (p.status !== 'proposed') return;
    const t = tally(v), cast = t.for + t.against + t.abstain;
    if (cast >= Math.ceil(p.quorum * N) && t.for + t.against > 0 && t.for / (t.for + t.against) >= p.thr) {
      db.prepare("update policies set status='superseded' where status='active'").run();
      db.prepare("update policies set status='active' where v=?").run(v);
      log('Members', 'votes closed', null, null, 'Approved', v, `${t.for} for, ${t.against} against, ${t.abstain} abstain`);
      log('System', 'policy activated', null, null, 'Active', v, p.title);
    }
  }
  function castVote(v: number, farmerId: number, choice: 'for' | 'against' | 'abstain') {
    const p = pol(v); if (!p) throw new HttpError(404, 'Unknown policy');
    if (farmerId < 1 || farmerId > N) throw new HttpError(403, 'Not an eligible member');
    if (p.status !== 'proposed') throw new HttpError(409, 'Voting is closed for this policy');
    if (db.prepare('select 1 from votes where policy_v=? and farmer_id=?').get(v, farmerId)) {
      log(`Farmer #${farmerId}`, 'vote rejected', null, null, 'Denied', v, 'duplicate vote attempt');
      throw new HttpError(409, 'Duplicate vote blocked');
    }
    db.prepare('insert into votes values (?,?,?)').run(v, farmerId, choice);
    log(`Farmer #${farmerId}`, 'vote cast', null, null, 'Recorded', v, 'Choice kept private; tally only');
    evalPolicy(v);
    return { policy: pol(v), tally: tally(v) };
  }
  function propose(i: { title: string; purposes: string[]; k: number; maxDays: number; thr: number }) {
    if (i.purposes.includes('Data resale')) throw new HttpError(400, 'Data resale cannot be enabled');
    const v = (db.prepare('select max(v) m from policies').get() as any).m + 1;
    db.prepare("insert into policies values (?,?,'proposed',?,?,?,?,0.5,?)").run(v, i.title, JSON.stringify(i.purposes), i.k, i.maxDays, i.thr, now());
    log('FPO Admin', 'policy proposed', null, null, 'Open for voting', v, i.title);
    return pol(v);
  }
  const getReq = (id: string): any => { const r = db.prepare('select * from requests where id=?').get(id); if (!r) throw new HttpError(404, 'Unknown request'); return r; };
  function refreshExpiry() {
    for (const r of db.prepare("select * from requests where status='Approved' and exp < ?").all(now()) as any[]) {
      db.prepare("update requests set status='Expired' where id=?").run(r.id);
      log('System', 'access expired', r.ds, r.purpose, 'Expired', r.apv, r.id);
    }
  }
  function submit(org: string, i: { purpose: string; out: string; days: number; contact: string }) {
    const o = OUTPUTS[i.out]; if (!o) throw new HttpError(400, 'Unknown output');
    const id = 'R-' + (101 + (db.prepare('select count(*) c from requests').get() as any).c);
    db.prepare("insert into requests values (?,?,?,?,?,?,?,'Pending',?,null,null,'',0)").run(id, org, i.purpose, o.ds, i.out, i.days, i.contact, now());
    log(org, 'request submitted', o.ds, i.purpose, 'Pending', active().v, id);
    return getReq(id);
  }
  function review(id: string, decision: 'approve' | 'reject') {
    const r = getReq(id), p = active();
    if (r.status !== 'Pending') throw new HttpError(409, 'Only pending requests can be reviewed');
    let why = '';
    if (decision === 'approve') {
      if (!p.purposes.includes(r.purpose)) why = `Purpose "${r.purpose}" is not permitted by active policy v${p.v}. Members have not approved it.`;
      else if (r.days > p.max_days) why = `Duration ${r.days} days exceeds the policy maximum of ${p.max_days}.`;
    }
    if (decision === 'approve' && !why) {
      const exp = now() + r.days * D;
      const reason = `Matched policy v${p.v}: "${r.purpose}" permitted, ${r.days} days, group-level output only, minimum group size ${p.k}.`;
      db.prepare("update requests set status='Approved', apv=?, exp=?, reason=? where id=?").run(p.v, exp, reason, id);
      log('FPO Admin', 'request approved', r.ds, r.purpose, 'Approved', p.v, id);
    } else {
      db.prepare("update requests set status='Rejected', reason=? where id=?").run(why || 'Rejected by administrator.', id);
      log('FPO Admin', 'request rejected', r.ds, r.purpose, 'Rejected', p.v, `${id}: ${why}`);
    }
    return getReq(id);
  }
  function revoke(id: string) {
    const r = getReq(id);
    if (r.status !== 'Approved') throw new HttpError(409, 'Only approved requests can be revoked');
    db.prepare("update requests set status='Revoked', reason=? where id=?").run('Revoked by FPO. Future releases are blocked. Files already downloaded cannot be recalled.', id);
    log('FPO Admin', 'access revoked', r.ds, r.purpose, 'Revoked', r.apv, id);
    return getReq(id);
  }
  function aggregate(out: string, k: number) {
    const rows = db.prepare('select village, crop, yield, irr from farmers').all() as any[];
    const by = (key: string) => { const m: Record<string, any[]> = {}; rows.forEach(f => (m[f[key]] = m[f[key]] || []).push(f)); return Object.entries(m); };
    const res: { label: string; suppressed: boolean; value?: number; unit?: string; text?: string; n?: number }[] = [];
    for (const [label, a] of by(out === 'yield_crop' || out === 'crop_dist' ? 'crop' : 'village')) {
      if (a.length < k) { res.push({ label, suppressed: true }); continue; }
      if (out === 'crop_dist') res.push({ label, suppressed: false, value: +(a.length / N * 100).toFixed(1), unit: '% of members', n: a.length });
      else if (out === 'irr_village') res.push({ label, suppressed: false, n: a.length, text: IR.map(t => { const c = a.filter(x => x.irr === t).length; return c < k ? `${t}: suppressed` : `${t} ${Math.round(c / a.length * 100)}%`; }).join(', ') });
      else res.push({ label, suppressed: false, value: +(a.reduce((s, x) => s + x.yield, 0) / a.length).toFixed(1), unit: 'q/acre', n: a.length });
    }
    return res;
  }
  /** The only path by which data leaves the system. Returns group-level rows only. */
  function release(id: string, org: string) {
    refreshExpiry();
    const r = getReq(id), p = active();
    if (r.org !== org) throw new HttpError(403, 'Not your request');
    const deny = (why: string): never => { log(org, 'access denied', r.ds, r.purpose, 'Denied', p.v, `${id}: ${why}`); throw new HttpError(403, why); };
    if (r.status === 'Revoked') deny('This access was revoked.');
    if (r.status === 'Expired') deny('The approval has expired.');
    if (r.status !== 'Approved') deny(`The request is ${r.status.toLowerCase()}; no governance approval exists.`);
    if (!p.purposes.includes(r.purpose)) deny(`Active policy v${p.v} no longer permits "${r.purpose}".`);
    if (r.rel >= MAX_RELEASES) deny('Release budget used up; this limits repeated narrow queries.');
    const rows = aggregate(r.out, p.k);
    db.prepare('update requests set rel=rel+1 where id=?').run(id);
    log(org, 'data released', r.ds, r.purpose, 'Allowed', p.v, `${id} ${OUTPUTS[r.out].label}, ${rows.filter(x => x.suppressed).length} rows suppressed`);
    if (r.rel === 0) db.prepare('insert into ledger values (?,?,?)').run(now(), `Simulated contribution from ${id}`, r.purpose === 'Academic research' ? 5000 : 0);
    return { requestId: id, policyVersion: p.v, minGroupSize: p.k, rows, notice: 'Aggregation and suppression reduce disclosure risk but do not guarantee anonymity.' };
  }
  function refuseRaw(id: string, org: string) {
    const r = getReq(id);
    log(org, 'access denied', r.ds, r.purpose, 'Denied', active().v, `${id}: raw individual records requested`);
    throw new HttpError(403, 'Raw individual farmer records are never released.');
  }
  function verifyChain() {
    let prev = 'genesis';
    for (const e of db.prepare('select * from audit order by i').all() as any[]) {
      if (e.prev !== prev || eh(prev, [e.i, e.ts, e.actor, e.action, e.ds, e.purpose, e.decision, e.pv, e.detail]) !== e.hash) return { valid: false, brokenAt: e.i };
      prev = e.hash;
    }
    return { valid: true, brokenAt: null };
  }
  function advance(days: number) { db.prepare("insert or replace into meta values ('now', ?)").run(String(now() + days * D)); log('System', 'demo clock advanced', null, null, 'Info', active().v, `+${days} days`); refreshExpiry(); }

  function seed() {
    const r = rng(42); let id = 1; const ins = db.prepare('insert into farmers values (?,?,?,?,?,?)');
    db.transaction(() => {
      VIL.forEach(([v, n]) => { for (let i = 0; i < n; i++) { const c = CR[Math.floor(r() ** 1.3 * 5)]; ins.run(id++, v, c[0], +(c[1] * (0.8 + r() * 0.4)).toFixed(1), IR[Math.floor(r() * 3)], +(5.8 + r() * 1.8).toFixed(1)); } });
      const ip = db.prepare("insert into policies values (?,?,?,?,10,45,0.66,0.5,?)");
      ip.run(1, 'Baseline research sharing', 'active', JSON.stringify(['Academic research']), T0 - 120 * D);
      ip.run(2, 'Add government planning use', 'proposed', JSON.stringify(['Academic research', 'Government planning']), T0 - 14 * D);
      const iv = db.prepare('insert into votes values (?,?,?)');
      for (let i = 1; i <= 100; i++) iv.run(1, i, i % 10 === 0 ? 'against' : i % 17 === 0 ? 'abstain' : 'for');
      for (let i = 20; i <= 77; i++) iv.run(2, i, i <= 60 ? 'for' : i <= 72 ? 'against' : 'abstain');
      const A = 'FPO Admin', O = ORGS;
      log(A, 'policy proposed', null, null, 'Open for voting', 1, 'Baseline research sharing', T0 - 120 * D);
      log('Members', 'votes closed', null, null, 'Approved', 1, 'Quorum met, approval above 66%', T0 - 110 * D);
      log(A, 'policy activated', null, null, 'Active', 1, '', T0 - 110 * D);
      const rq = db.prepare('insert into requests values (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      rq.run('R-101', O[0], 'Academic research', 'ds1', 'yield_crop', 30, 'research@terai-demo.example', 'Expired', T0 - 90 * D, 1, T0 - 60 * D, 'Matched policy v1: academic research, 30 days.', 1);
      rq.run('R-102', O[0], 'Academic research', 'ds1', 'yield_crop', 30, 'research@terai-demo.example', 'Pending', T0 - 2 * D, null, null, '', 0);
      rq.run('R-103', O[2], 'Commercial product', 'ds1', 'crop_dist', 90, 'data@agrimart-demo.example', 'Pending', T0 - D, null, null, '', 0);
      log(O[0], 'request submitted', 'ds1', 'Academic research', 'Pending', 1, 'R-101', T0 - 90 * D);
      log(A, 'request approved', 'ds1', 'Academic research', 'Approved', 1, 'R-101', T0 - 90 * D);
      log(O[0], 'data released', 'ds1', 'Academic research', 'Allowed', 1, 'R-101 Average yield by crop', T0 - 89 * D);
      log('System', 'access expired', 'ds1', 'Academic research', 'Expired', 1, 'R-101', T0 - 60 * D);
      log(A, 'policy proposed', null, null, 'Open for voting', 2, 'Add government planning use', T0 - 14 * D);
      log(O[0], 'request submitted', 'ds1', 'Academic research', 'Pending', 1, 'R-102', T0 - 2 * D);
      log(O[2], 'request submitted', 'ds1', 'Commercial product', 'Pending', 1, 'R-103', T0 - D);
      db.prepare('insert into ledger values (?,?,?)').run(T0 - 89 * D, 'Contribution from R-101 (simulated)', 5000);
      db.prepare('insert into ledger values (?,?,?)').run(T0 - 70 * D, 'Soil-testing camp (simulated)', -3500);
    })();
  }
  if (!(db.prepare('select count(*) c from farmers').get() as any).c) seed();
  return { db, now, log, pol, active, tally, castVote, propose, getReq, submit, review, revoke, release, refuseRaw, verifyChain, advance, refreshExpiry };
}
export type Store = ReturnType<typeof createStore>;
