# Khet Data Trust

Prototype of **community-led data governance** for a Farmer Producer Organisation (FPO): members vote on data-sharing rules, the FPO reviews requests against the active policy, only group-level summaries leave the system, and every decision is written to a hash-chained audit log.

> **Synthetic data only.** This is a prototype, not a claim that FPOs hold a legal trustee role, and not a production system.

## What is here

| Part | Location | Status |
|---|---|---|
| Backend API (Express, TypeScript, SQLite, Zod) | `src/` | Source complete. Enforces voting, purpose, expiry, revocation, release budget, suppression, audit chain |
| Database schema + deterministic synthetic seed (120 farmers, 6 villages) | `src/core.ts` | Auto-created and seeded on first start |
| Tests (Vitest + Supertest) | `tests/workflows.test.ts` | Voting, authorization, purpose, expiry, revocation, privacy thresholds, audit tamper detection, HTTP access control |
| Frontend | `public/index.html` | **Standalone demo mode**: single-file UI with its own browser-side logic. It is **not yet wired to the API** |

## Requirements

Node.js 20 or 22 LTS and npm. `better-sqlite3` is a native module (prebuilt binaries are used when available; otherwise a C++ toolchain is needed).

## Install and run

```bash
npm install
cp .env.example .env        # optional
npm run dev                 # http://localhost:3000
```

Production-style: `npm run build && npm start`. Reset the database: `npm run db:reset`.

Open `http://localhost:3000` for the demo UI. The API is under `/api`.

## Tests

```bash
npm test
```

Tests use an in-memory SQLite database seeded identically on each run.

## API demo (curl)

Auth is **demo-only static bearer tokens**, not production authentication: `demo-admin`, `demo-farmer-<1..120>`, `demo-requester-<1..3>` (change the admin token with `DEMO_ADMIN_TOKEN`).

```bash
H='Content-Type: application/json'
# Admin approves pending request R-102 (academic research)
curl -X POST localhost:3000/api/requests/R-102/approve -H 'Authorization: Bearer demo-admin'
# Requester gets group-level output only
curl -X POST localhost:3000/api/requests/R-102/release -H 'Authorization: Bearer demo-requester-1'
# Requester asks for raw records -> 403, logged
curl localhost:3000/api/requests/R-102/raw -H 'Authorization: Bearer demo-requester-1'
# Commercial request R-103 is rejected by policy with a reason
curl -X POST localhost:3000/api/requests/R-103/approve -H 'Authorization: Bearer demo-admin'
# Farmers vote on policy v2 (needs 60 votes cast, 66% approval; 58 are seeded)
curl -X POST localhost:3000/api/policies/2/vote -H "$H" -H 'Authorization: Bearer demo-farmer-7' -d '{"choice":"for"}'
curl -X POST localhost:3000/api/policies/2/vote -H "$H" -H 'Authorization: Bearer demo-farmer-8' -d '{"choice":"for"}'
# Expiry: advance the demo clock, then release again -> denied
curl -X POST localhost:3000/api/admin/advance -H "$H" -H 'Authorization: Bearer demo-admin' -d '{"days":31}'
# Verify the audit chain
curl localhost:3000/api/audit/verify -H 'Authorization: Bearer demo-admin'
```

## Design notes and limitations

- All authorization and release checks live in `src/core.ts` and the API; the only data path out is `release()`, which returns suppressed group-level rows (minimum group size from the active policy, default 10). No API route returns individual farmer rows.
- Each approval allows 3 releases, one grouping dimension per output, and no free-form filters, to limit repeated narrow queries.
- Suppression and aggregation reduce disclosure risk but **do not guarantee anonymity**.
- The audit log is a local SHA-256 hash chain. It is tamper-evident only, and is **not** a production-grade immutable ledger or blockchain.
- Revocation blocks future releases; it cannot erase outputs already downloaded.
- Auth is demo tokens. No legal compliance is claimed. Benefit amounts are simulated.
- Votes store the choice for tally; the audit log records only that a vote occurred.

## Roadmap

Wire `public/index.html` to the API, add real authentication, versioned policy edits for settings changes, rate limiting, and external log anchoring.
