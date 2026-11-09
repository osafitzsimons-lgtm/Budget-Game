# Budget Guy

A private, phone-first weekly budget app for one person. You upload your bank statement PDFs every week as proof, and a small rice sprout's health goes up or down depending on what they show.

**Setup:** see [SETUP.md](SETUP.md).

## How it works

- **Statements are read on your phone.** The PDF is parsed in the browser with a locally bundled pdf.js. It is never uploaded or stored. Only these fields are saved for each row: date, time, payee, amount, category and running balance, plus the last three digits of the account.
- **Weeks run Sunday to Saturday** (Asia/Phnom_Penh). Statements are due the following **Sunday at 20:00**.
- **There are no cron jobs.** Missed deadlines are worked out whenever the app is opened. Once every required statement for a finished week is in, the week is scored straight away and the change is animated.
- **Every `/api` request** checks the Cloudflare Access token (signature, team, audience, expiry and your email) and fails closed if any setting is missing.

## Scoring

The sprout starts at 70 and stays between 0 and 100. Before Sunday 29 Nov 2026, losses are halved (rounded towards zero).

| What | Change |
|---|---|
| Negotiable spending ≤ 80% of the weekly allowance | +15 |
| ≤ 100% | +8 |
| ≤ 120% | −10 |
| ≤ 150% | −20 |
| > 150% | −35 |
| No valid statement by the deadline (once per week) | −25 |
| Proof check still failing at the deadline | −25 |
| Each negotiable of $30+ with no "write it down" entry first (within $2, up to 2 days before) | −5 |
| Savings target moved by the 3rd of the month | +10, otherwise −30 |

At 0 he dies and goes in the graveyard. The app shows "$25 extra to savings next payday" and adds $25 to the next month's target, and a new sprout starts at 40. Every change is logged with its reason on the History screen.

### Decisions where the brief left room

- **Missing or failing week:** you get only the −25, with no spending score. A late upload doesn't reopen a closed week.
- **Failing statements:** a statement that fails the proof check is recorded as an attempt, but its rows are not saved. Upload a statement that covers the gap to fix it before the deadline.
- **"Previous Saturday":** the most recent Saturday before today. On a Sunday that is yesterday.
- **Built-in rules come before remembered payees** for Grab, TADA under $5, and cash withdrawals. Your history labels "Grab" both ways and cash withdrawals as Transfer, which would otherwise override the amount and cash rules.
- **TADA $5 or more** has no rule, so it uses the remembered payee, or Unidentified if there isn't one.
- **Unknown money coming in** counts as Transfer (not spending). If it's $10 or more it goes to review, so you can mark it "Friends paying back".
- **Cash withdrawals** count as negotiable spending (Unidentified) in the week you withdraw. Log what the cash bought on *Write it down*. Cash spent on something committed (for example rent) comes off that week's spending.
- **Savings for a month** count if they're dated from the 25th of the previous month to the 3rd. The start day can be changed in Settings. If the nominated savings account's own statements are uploaded, money arriving there is counted. Otherwise transfers out that mention it (or a savings keyword) are counted.
- **Revolut sections** must join up: each section's closing balance is the next one's opening. Your expected numbers show this (section 1 closes at 57.56, and section 2's figures imply it opens at 57.56). If the sections don't join up, the upload stops.
- **Imported CSV history** fills History until the first uploaded statement for that bank. From then on only statements are used, so nothing is counted twice.
- **Payees:** any run of 6 or more digits (account or card numbers) is reduced to its last three, e.g. `•••659`.

## Stack

TypeScript, Cloudflare Worker with static assets, D1, Preact, Vite and Vitest. It fits the Workers free plan:

- Only `/api/*` runs Worker code.
- Database writes are batched into single `json_each` inserts.
- Confirming an 849-row statement takes about 3.5 ms of CPU in a local benchmark.

```
src/parsers   PDF text → lines → ABA / Revolut statements (pure, runs in browser and tests)
src/shared    dates (Phnom Penh), categorising, proof checks, scoring, CSV, history
src/worker    API, Access JWT check, D1 schema (self-applying), deadline scoring
src/web       Preact screens, SVG sprout, service worker (static files only)
tests         unit + integration tests with synthetic PDFs and a local D1
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Builds, starts a local Worker and database, and loads fake history. Fake PDFs are written to `sample-data/`. |
| `npm test` | Runs all tests. Real-file checks run only if files are in `private-fixtures/`. |
| `npm run check` | Typecheck, tests and build. |
| `npm run schema` | Regenerates `migrations/0001_init.sql` from the schema. |

## Privacy rules for this repo

Statements, CSVs, `.dev.vars`, `.env` and `private-fixtures/` are all in `.gitignore`. Test fixtures are synthetic and generated in code.
