# Missing Endpoints — Build Roadmap

> Snapshot taken 2026-05-12. Re-audit any time the schema or routes change.

This document is the canonical list of endpoints we have **designed in the
Prisma schema** but **not yet exposed as HTTP routes**. It is the worklist
we work from until the API surface is complete.

**Status legend:** rows marked `✅` are shipped and have an Swagger schema,
service-layer implementation, and e2e or integration coverage. Unticked
rows are still on the to-do list.

---

## Rule: every new route gets full Swagger

Every route added from here on **must** declare a `schema` block with:

| Field | Required? | Purpose |
|---|---|---|
| `tags` | yes | Group in Swagger UI sidebar |
| `summary` | yes | One-line title |
| `description` | yes | Behavior, side effects, state transitions, authorization |
| `operationId` | yes | Stable codegen / SDK key |
| `security: [{ bearerAuth: [] }]` | when protected | Bearer-JWT gate |
| `body` / `params` / `querystring` | when applicable | Same JSON Schema runtime validates against |
| `response` | yes | Happy path **AND every error code**, error slots referencing `errorResponses[code]` from `src/lib/api-schemas.js` |

If a route omits any of these, treat it as a bug.

---

## Currently shipped (as of snapshot date)

```
Auth        POST   /auth/login                — public
Auth        GET    /auth/me                   — bearer
Auth        POST   /auth/change-password      — bearer  (self-service)
Auth        POST   /auth/logout               — bearer  (symbolic)
Users       POST   /users                     — admin
Users       GET    /users                     — admin
Users       GET    /users/{id}                — admin
Users       PATCH  /users/{id}                — admin
Users       POST   /users/{id}/password       — admin
Settings    GET    /settings                  — bearer
Settings    PATCH  /settings                  — admin
Collectors  POST   /collectors                — admin
Collectors  GET    /collectors                — bearer
Collectors  GET    /collectors/code/{code}    — bearer
Collectors  GET    /collectors/{id}           — bearer
Collectors  PATCH  /collectors/{id}           — admin
Fights      POST   /fights                    — admin
Fights      GET    /fights                    — bearer
Fights      GET    /fights/{id}               — bearer
Fights      POST   /fights/{id}/close         — admin
Fights      POST   /fights/{id}/settle        — admin
Fights      POST   /fights/{id}/cancel        — admin
Fights      POST   /fights/{id}/correct       — admin
Fights      POST   /fights/{id}/sides/{s}/hold    — admin
Fights      POST   /fights/{id}/sides/{s}/unhold  — admin
Bets        POST   /bets                      — teller
Bets        GET    /bets                      — bearer  (teller-scoped)
Bets        GET    /bets/{id}                 — bearer  (teller-scoped)
Bets        GET    /bets/code/{code}          — bearer
Bets        POST   /bets/{id}/void            — bearer  (teller or admin)
Bets        POST   /bets/{id}/pay             — bearer
Cash        POST   /cash/advances             — admin
Cash        POST   /cash/remits               — bearer
Cash        GET    /cash/balance              — bearer
Cash        GET    /cash/ledger               — bearer
Cash        GET    /cash/ledger/code/{code}   — bearer
Reports     GET    /reports/teller-commissions — admin
Session     GET    /session/preview           — admin
Session     POST   /session/reset             — admin  (step-up password)
Session     GET    /session/resets            — admin  (audit log)
System      GET    /
System      GET    /health
Realtime    GET    /ws                        — query JWT
```

**Outstanding work:** three Tier-3 Reports endpoints (per-fight P&L,
session totals, per-teller shift summary). Everything else from Tiers 1–4
is shipped — see the individual tier tables below for per-route status.

---

## Build order (dependency-respecting)

1. **Settings + Collectors** — tiny, no dependencies, gives admin the UI knobs they need.
2. **Fights module** — Tier 1; unblocks ending the psql-insert hack for testing.
3. **Bet management** — void, pay, list, lookup by code (Tier 2).
4. **Cash workflow** — advance, remit, adjustment, balance, ledger view (Tier 2).
5. **Reports / admin dashboard** — Tier 3.
6. **Session reset** — Tier 4.
7. **Optional auth hardening** — only if needed.

---

## 🟥 Tier 1 — Fights module ✅ shipped

| Method | Path | Who | What | Side effects |
|---|---|---|---|---|
| POST | `/fights` ✅ | admin | Create a new fight **directly in `OPEN`** state (no separate schedule step). Asserts no other fight is OPEN. Snapshots `Setting.commissionRate`. Auto-increments `fightNumber`. Stamps `openedAt`. | Broadcast `FIGHT_OPENED`. |
| GET | `/fights` ✅ | bearer | List fights. Filters: `status`, `current`, pagination. | — |
| GET | `/fights/{id}` ✅ | bearer | Fight detail (pool totals, side hold state, outcome). | — |
| POST | `/fights/{id}/close` ✅ | admin | `OPEN → CLOSED`. Stamps `closedAt`. | Broadcast `FIGHT_CLOSED`. |
| POST | `/fights/{id}/settle` ✅ | admin | `CLOSED → SETTLED`. Body: `{ outcome: MERON\|WALA\|DRAW\|NO_CONTEST }`. Transaction: computes payout ratios from snapshotted commission, marks every Bet as WON/LOST/REFUNDED, freezes `payoutRatioMeron`/`payoutRatioWala`. | Broadcast `FIGHT_SETTLED` + `TELLER_COMMISSIONS_UPDATED`. |
| POST | `/fights/{id}/cancel` ✅ | admin | `OPEN\|CLOSED → CANCELLED`. Transaction: marks every PENDING bet REFUNDED and writes one `BET_REFUNDED` ledger entry per bet (negative). | Broadcast `FIGHT_CANCELLED` + `TELLER_COMMISSIONS_UPDATED`. |
| POST | `/fights/{id}/correct` ✅ | admin | `SETTLED → SETTLED` with new outcome. Snapshots `previousOutcome`/`previousPayoutRatio*` + `correctionReason`. Rewrites bet statuses; preserves `paidAt` on already-paid bets (operator loss). | Broadcast `FIGHT_CORRECTED` + `TELLER_COMMISSIONS_UPDATED`. |
| POST | `/fights/{id}/sides/{side}/hold` ✅ | admin | Set `<side>AcceptingBets=false`. Valid only while `status=OPEN`. Stamps `<side>HeldAt` + `<side>HeldByUserId`. | Broadcast `SIDE_HELD`. |
| POST | `/fights/{id}/sides/{side}/unhold` ✅ | admin | Resume the side. | Broadcast `SIDE_UNHELD`. |

---

## 🟧 Tier 2 — Bet lifecycle beyond placement ✅ shipped

| Method | Path | Who | What | Side effects |
|---|---|---|---|---|
| GET | `/bets` ✅ | bearer | List bets. Filters: `fightId`, `tellerId`, `status`, `side`, `since`, pagination. Tellers see only their own; admins see any. | — |
| GET | `/bets/{id}` ✅ | bearer | Single bet detail. Tellers see only their own; admins see any. | — |
| GET | `/bets/code/{code}` ✅ | bearer | Look up a bet by its 8-char public ticket code. Cashier-window path; any auth. | — |
| POST | `/bets/{id}/void` ✅ | bearer | Void a `PENDING` bet **while fight is OPEN**. Transaction: status → `VOIDED`, decrement the relevant pool, write `BET_VOIDED` ledger entry (negative, on the **original** teller). Allowed for the original teller or admin. **REJECTS** if fight is not OPEN. | Broadcast `ODDS_UPDATE` + `TELLER_BALANCE_UPDATED`. |
| POST | `/bets/{id}/pay` ✅ | bearer | Redeem a `WON` ticket. Transaction: status `WON → PAID`, stamp `paidAt` + `paidByUserId`, write `PAYOUT` ledger entry (negative, on the **paying** teller — schema comment). | Broadcast `TELLER_BALANCE_UPDATED`. |

### Hard rule (carry forward to all related code)

> Bets cannot be voided once the fight begins. The void route MUST re-validate
> `fight.status === 'OPEN'` **inside the row-locked transaction** — not just
> at the route layer. Admin overrides do not bypass this check; once betting
> is closed, the bet's fate is determined by settlement only.

---

## 🟧 Tier 2 — Cash workflow (TellerLedger surface) ✅ shipped

> **Policy: no manual balance adjustments.** Every TellerLedger row must trace
> to a real business event (advance, remit, bet, void, payout, refund). There
> is intentionally NO `POST /cash/adjustments` endpoint — fixing a mistake
> has to be done by emitting the correct reversing business event. This
> keeps the audit trail clean and prevents an "admin god-mode" loophole.

| Method | Path | Who | What | Side effects |
|---|---|---|---|---|
| POST | `/cash/advances` ✅ | admin | Record cash advance from a collector to a teller. Body: `{ tellerId, collectorId, amount, notes? }`. Validates recipient is active TELLER + collector is active. Writes `CASH_ADVANCE` (+) on the teller. **Issues an 8-char "ADV…" barcode** printed on the receipt. | Broadcast `TELLER_BALANCE_UPDATED`. |
| POST | `/cash/remits` ✅ | bearer | Teller hands cash back to a collector at shift end. Body: `{ collectorId, amount, notes? }`. Writes `REMIT` (−) on the requesting user. **Hard invariant:** post-write SUM check — remit cannot push balance negative (409 with `currentBalanceBeforeRemit` + `requestedAmount` + `shortfall` if it would). **Issues an 8-char "REM…" barcode** printed on the receipt. | Broadcast `TELLER_BALANCE_UPDATED`. |
| GET | `/cash/balance` ✅ | bearer | Running balance: `SUM(amount) WHERE tellerId = ?`. Default = own. Admins can pass `?tellerId=`; tellers passing a different id → 403. | — |
| GET | `/cash/ledger` ✅ | bearer | List ledger entries. Filters: `tellerId`, `type`, `since`, `until`. Cursor-paginated. Tellers are hard-scoped to their own (403 on cross-teller queries). | — |
| GET | `/cash/ledger/code/{code}` ✅ | bearer | Scan-by-barcode lookup for an advance/remit row. Tellers are hard-scoped (cross-teller scan returns **404**, not 403, to prevent code enumeration). | — |

### Bundled retrofit on existing endpoints

Now that the cash module exists, the previously-stubbed `TELLER_BALANCE_UPDATED` broadcast is wired into every cash-affecting operation. All five mutating endpoints (`POST /bets`, `POST /bets/{id}/void`, `POST /bets/{id}/pay`, `POST /cash/advances`, `POST /cash/remits`) now broadcast the frame and return `actorBalance` in the HTTP response so the calling kiosk can self-update without waiting for the WS round-trip.

---

## 🟨 Tier 3 — Settings + Collectors ✅ shipped

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/settings` ✅ | bearer | Return the singleton `Setting` row (current commission rate). |
| PATCH | `/settings` ✅ | admin | Update commission rate (range 0.0000–0.3000). Audit-logged. Only affects **future** fights — existing fights keep their snapshot. |
| POST | `/collectors` ✅ | admin | Create a collector. Name normalized (trim + collapse whitespace), unique. **Auto-issues an 8-char "COL…" barcode** printed on the collector's badge / wristband. |
| GET | `/collectors` ✅ | bearer | List collectors (filter by `isActive`). Active first, then alpha. |
| GET | `/collectors/code/{code}` ✅ | bearer | Scan-by-barcode lookup. Returns retired collectors too — UI uses `isActive` to decide. |
| GET | `/collectors/{id}` ✅ | bearer | Single collector detail. |
| PATCH | `/collectors/{id}` ✅ | admin | Rename and/or set `isActive` (soft-delete). No DELETE — FK-pinned by ledger. |

---

## 🟨 Tier 3 — Reports / admin dashboard

| Method | Path | Who | What | Side effects |
|---|---|---|---|---|
| GET | `/reports/teller-commissions` ✅ | admin | Per-teller commission attribution leaderboard. Returns `{ tellerId, username, fullName, isActive, betCount, grossHandle, winningStake, losingStake, commissionGenerated }` per teller (sorted by commission DESC), plus a `totals` row for the sanity invariant `SUM(tellers[i].commissionGenerated) === totals.commissionGenerated`. Filters: `since`, `until`, `fightId`, `includeInactive`. Math: `commissionGenerated = SUM(bet.stake × bet.fight.commissionRate)` over `bet.status IN ('WON', 'LOST', 'PAID')`. Real-time: `TELLER_COMMISSIONS_UPDATED` broadcast after every fight settle / cancel / correct. | — (read-only; broadcasts come from the fight handlers that mutate underlying state) |
| GET | `/reports/fight/{id}` | admin | Per-fight P&L: gross handle, commission take, total payouts, winners count, settlement summary, any corrections. | — |
| GET | `/reports/session` | admin | Whole-session totals: handle, commission, payouts, net, fights count by status, open exposure. | — |
| GET | `/reports/teller/{id}` | admin | Per-teller shift summary: advances received, bets taken, payouts made, voids, balance, remits made. | — |

---

## 🟦 Tier 4 — Session reset ✅ shipped

| Method | Path | Who | What | Side effects |
|---|---|---|---|---|
| GET | `/session/preview` ✅ | admin | Read-only "what would happen if I wiped now?" — counts plus per-invariant violation breakdown (with per-teller balances when relevant). | — |
| POST | `/session/reset` ✅ | admin | TRUNCATEs `Fight`, `Bet`, `TellerLedger` in a single transaction. Preserves `User`, `Collector`, `Setting`, and `SessionReset` (the audit table itself). Body: `{ confirm: "WIPE-SESSION", password, notes?, force? }`. **Three guardrails: (1)** admin bearer JWT, **(2)** magic confirmation token, **(3)** step-up password re-entry (compared to `User.password` as stored; failed attempts logged at WARN). **Pre-flight invariants** (open/closed fight, unpaid winner, non-zero teller balance) block the wipe with 409 unless `force: true`. Every reset writes a permanent `SessionReset` audit row. | Broadcast `SESSION_RESET`. |
| GET | `/session/resets` ✅ | admin | Cursor-paginated audit log of past resets. Includes performer username/fullName, counts destroyed, notes, and `forced` flag. Survives subsequent resets. | — |

---

## 🟦 Tier 4 — Auth hardening ✅ shipped

| Method | Path | Who | What | Side effects |
|---|---|---|---|---|
| POST | `/auth/change-password` ✅ | bearer | Self-service password change. Body: `{ currentPassword, newPassword }`. Current password re-verified against stored `User.password` (generic 401 on mismatch). New password validated against the shared password policy (`src/lib/password-policy.js`: 8–256 chars, weak-password denylist) AND rejected if equal to current. Failed verification logged at WARN; success logged at INFO. | — |
| POST | `/auth/logout` ✅ | bearer | Symbolic. The JWT remains cryptographically valid until its natural `exp` — there is intentionally no `jti` denylist (single-shop LAN threat model; see route description). Clients drop the token locally; the audit log records the intent. If a forced eviction is needed RIGHT NOW, an admin can set `isActive: false` on the user — `app.authenticate` re-fetches per call so the next request is 401. | — |

---

## Totals

**~32 new endpoints** to round out the system, distributed roughly:

- Fights: 9
- Bets (beyond placement): 5
- Cash / Ledger: 4 (no manual adjustments — see policy note above)
- Settings + Collectors: 6
- Reports: 3
- Session: 3 (preview, reset, audit log)
- Auth hardening: 2 (change-password, logout)
