# Commerce OS

An e-commerce operating system for orders, customers, inventory, production, shipping, private drivers, collections, marketing and profitability. It works manually first. Integrations are optional and not yet built.

## Stack

| Layer | Technology | Where |
|---|---|---|
| Database | PostgreSQL (Neon or similar in production) | `db/migrations/` |
| API | Node, Fastify, TypeScript. Runs as one Vercel function, or as a normal server locally | `server/` |
| Business rules | JavaScript, shared by server and browser | `packages/domain/` |
| Web app | Vite, JavaScript modules (no UI framework) | `web/` |
| Accounts | Server sessions, scrypt password hashes, role checks on every command | `server/src/auth.ts`, `packages/domain/src/permissions.js` |
| Hosting | Vercel Build Output API | `scripts/build-vercel.mjs`, `vercel.json` |
| Tests | Node test runner, Playwright, ESLint | `packages/domain/test/`, `server/test/`, `e2e/` |

`prototype/` holds the original HTML prototype and its source. The app doesn't use it.

## How it works

**Changes.** The browser sends a command, such as `confirmOrder`, to `POST /api/commands/:name`. Then, in one database transaction:
1. The server checks the user's role and locks the workspace row, so changes apply one at a time across every server instance.
2. It loads only the records that command reads (`server/src/scope.ts`), plus stock and reservation totals.
3. It runs the shared business rules, then writes the changed rows and logs them in the `changes` table.

If anything fails, nothing is saved.

**Reading.** Staff browsers download the workspace in pages under 3 MB (`/api/snapshot`), then poll `/api/changes` every few seconds for only what changed. Drivers receive only their own deliveries (`/api/snapshot/mine`).

**Who sees what.** The server removes what a role may not read before data leaves the database (`redactRow` in `packages/domain/src/permissions.js`). Owner and finance see everything. Operations and warehouse don't receive product costs, profit, campaign spend or company expenses, and warehouse doesn't receive the customer contact log. Screens hide the matching columns.

**Money.** Every figure comes from dated records through one ledger (`orderEntries` in `packages/domain/src/domain.js`), so screens can't disagree.

**Database rules.** PostgreSQL also enforces: unique payment, handover and settlement references; one active delivery per order; unique stock-movement keys; and an append-only stock journal and activity log.

**Closed periods.** Finance closes the books through a date (Finance → Closed periods). After that, no handover, settlement, campaign spend or expense can be added, back-dated or removed on or before that date, so the closed figures stay fixed. The figures at closing are stored, and the integrity check compares them with today's figures for the same dates. Only the owner can reopen, with a reason, and every close and reopen is kept.

## Run it locally

You need Node 22.18 or newer and PostgreSQL.

```bash
npm install
createdb commerce_os
cp .env.example .env      # then set SEED_PASSWORD
npm run db:seed           # tables, demo data and demo logins
npm run build
npm start                 # http://localhost:3001
```

For development with live reload, run `npm run dev` and open http://localhost:5173.

Demo logins: `owner@`, `ops@`, `warehouse@`, `finance@` and `driver@nilestudio.example`, all using `SEED_PASSWORD`.

## Deploy to Vercel

1. **Create a PostgreSQL database.** Neon is the simplest choice, and Vercel's Marketplace can create one for you. Copy its **pooled** connection string.
2. **Import the GitHub repo into Vercel.** `vercel.json` already sets the install and build commands. Leave the framework preset as "Other".
3. **Set environment variables** in the Vercel project:

| Variable | Value |
|---|---|
| `DATABASE_URL` | The pooled connection string |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Your first owner login, with a password of 10+ characters |
| `MIGRATE_ON_BUILD` | `1` for **Production** only, so preview builds never change the production database |
| `DEMO_TOOLS` | Optional. `1` turns on demo reset and the load test |

4. **Deploy.** Sign in with `ADMIN_EMAIL`.

**Demo data.** To load demo data into a separate demo database, run this from your computer:

```bash
DATABASE_URL="<demo database>" ALLOW_DEMO_SEED=1 SEED_PASSWORD="<password>" npm run db:seed
```

**Large backups.** Vercel limits uploads to 4.5 MB, so restore larger backups from your computer with `npm run db:restore -- file.json`. `npm run db:backup -- file.json` writes one.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Lint, business-rule tests, API tests and the parity test. **Wipes** the `commerce_os_test` database, which must exist. |
| `npm run test:e2e` | Builds the Vercel bundle, serves it the way Vercel routes requests, and runs the browser tests. **Wipes** `commerce_os_test`. Set `CHROME_PATH` to use an installed browser. |
| `node e2e/prod-check.mjs` | Production mode on an empty database, with two server instances sharing one database. **Wipes** `commerce_os_prod_check`, which must exist. |
| `npm run vercel-build` | Builds `.vercel/output`. `node scripts/serve-vercel.mjs` serves it locally. |
| `npm run typecheck` | Type-checks the server. |
| `npm run db:migrate` | Applies new migrations. |

**The parity test** (`server/test/parity.test.ts`) runs hundreds of random operations through the server and against a complete in-memory copy, then requires identical outcomes and final records. It catches a command loading too little data. When you add a command, add it to `scopeFor` in `server/src/scope.ts` and to the permissions table.

## Known limits

- **One change at a time.** Changes are serialized across the whole workspace through the database lock. That's correct and simple, and suits an operations team. Thousands of changes per minute would need finer-grained locks.
- **Full workspace in each staff browser.** Each staff browser holds the workspace, loaded in pages at sign-in. Very large histories will need server-side search and reports.
- **Read limits are by role, not by record.** Operations and warehouse receive every order and customer, without costs and profit. Limiting staff to some customers or areas would need record-level rules.
- **No integrations.** There are no live connections to stores, couriers, ad platforms or payment gateways.
- **Not accounting software.** There's no tax handling, and one workspace per deployment. Restoring a backup replaces closed periods along with everything else.
