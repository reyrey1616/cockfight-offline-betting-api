# Real-time Events (WebSocket) — Spec

> Snapshot taken 2026-05-11.
> Lean scope: WebSocket is reserved for events where **delayed delivery causes
> wrong behavior**. Everything else uses REST + page refresh.

---

## Scope rule

A state change earns a WebSocket frame **only** if a client making a decision
based on stale state would do the wrong thing:

| Decision impact | Real-time? |
|---|---|
| Kiosk would accept a bet on a closed fight | ✅ yes |
| Cashier would pay a ticket the admin just corrected | ✅ yes |
| A held side would still be offered to customers | ✅ yes |
| Admin would see an out-of-date list / total | ❌ no — refresh the page |
| Teller would see a stale balance | ❌ no — refresh the page |

Anything that doesn't fail the first test stays out of the WS layer. This
keeps the broadcast surface small, the plumbing simple, and the bandwidth
bounded — important for an offline LAN with many kiosks.

---

## Frame envelope (every frame)

```json
{
  "type": "FIGHT_CLOSED",
  "data": { /* event-specific payload */ },
  "ts":   "2026-05-11T22:32:00.000Z"
}
```

- `type` — string constant from the table below.
- `data` — event-specific shape (documented per type).
- `ts`   — ISO-8601 server time the event was emitted.

No sequence numbers, no per-user routing, no admin-only filtering. If/when
those become real needs we'll add them; today they would be premature.

---

## Authoritative event catalog

### 1. `WELCOME` — sent immediately after WS auth

Initial state snapshot so the kiosk starts in sync without a separate REST
round-trip. Sent **once** per connection.

```json
{
  "type": "WELCOME",
  "data": {
    "user": { "id": "...", "username": "...", "role": "TELLER" },
    "currentFight": {
      "id": "...", "fightNumber": 1042, "status": "OPEN",
      "commissionRate": "0.10",
      "meronPool": "12500.00", "walaPool": "9300.00",
      "meronOdds": 1.83, "walaOdds": 2.21,
      "meronAcceptingBets": true, "walaAcceptingBets": true
    }
  },
  "ts": "..."
}
```

If no fight is active, `currentFight` is `null`.

### 2. `PING` / `PONG` — keepalive

Server sends `PING` every 30 s. Client must respond with `PONG`. If no
`PONG` arrives within 30 s of the next `PING`, the server closes the
socket; the client should reconnect.

```json
{ "type": "PING", "ts": "..." }
{ "type": "PONG", "ts": "..." }
```

### 3. `ODDS_UPDATE` ✅ already shipped

Fires when a bet is **placed** (`POST /bets`) or **voided**
(`POST /bets/{id}/void`).

```json
{
  "type": "ODDS_UPDATE",
  "data": {
    "fightId": "...",
    "meronPool": "12600.00", "walaPool": "9300.00",
    "meronOdds": 1.81,        "walaOdds": 2.24
  },
  "ts": "..."
}
```

### 4. `FIGHT_OPENED` / `FIGHT_CLOSED` / `FIGHT_CANCELLED`

Same data shape — only the `type` and inner `status` differ.

```json
{
  "type": "FIGHT_OPENED",
  "data": {
    "fightId": "...",
    "fightNumber": 1043,
    "status": "OPEN"
  },
  "ts": "..."
}
```

- `FIGHT_OPENED` is the only signal that lets kiosks unlock the placement form.
- `FIGHT_CLOSED` is the single most important frame in the system — kiosks
  MUST disable "Place Bet" on receipt.
- `FIGHT_CANCELLED` tells clients all pending bets are now refunded.

### 5. `FIGHT_SETTLED`

```json
{
  "type": "FIGHT_SETTLED",
  "data": {
    "fightId": "...",
    "outcome": "MERON",                       // | "WALA" | "DRAW" | "NO_CONTEST"
    "payoutRatioMeron": "1.85",               // null for DRAW / NO_CONTEST
    "payoutRatioWala":  null,
    "meronPool": "15500.00",
    "walaPool":  "12300.00"
  },
  "ts": "..."
}
```

Unlocks the cashier window for winning-ticket payout.

### 6. `FIGHT_CORRECTED`

Fires after `POST /fights/{id}/correct`. **Critical for correctness** —
the cashier window must immediately stop honoring the old winners list
and start honoring the corrected one.

```json
{
  "type": "FIGHT_CORRECTED",
  "data": {
    "fightId": "...",
    "outcome": "WALA",
    "previousOutcome": "MERON",
    "payoutRatioMeron": null,
    "payoutRatioWala":  "1.72",
    "previousPayoutRatioMeron": "1.85",
    "previousPayoutRatioWala":  null,
    "correctionReason": "Wrong cock declared",
    "correctedAt": "..."
  },
  "ts": "..."
}
```

### 7. `SIDE_HELD` / `SIDE_UNHELD`

Fires after `POST /fights/{id}/sides/{side}/hold` and `.../unhold`. Kiosks
toggle the corresponding side button instantly.

```json
{
  "type": "SIDE_HELD",
  "data": {
    "fightId": "...",
    "side": "MERON",
    "accepting": { "meron": false, "wala": true }
  },
  "ts": "..."
}
```

Including `accepting` for both sides means a kiosk that briefly disconnected
and missed an earlier toggle still recovers correctly from the latest frame.

### 8. `TELLER_BALANCE_UPDATED`

Fires on **every TellerLedger append** so the admin dashboard can show
live running balances for every teller on the floor without polling.

```json
{
  "type": "TELLER_BALANCE_UPDATED",
  "data": {
    "tellerId":   "...",
    "tellerName": "Juan Dela Cruz",
    "balance":    "5250.00",
    "delta": {
      "type":   "BET_PLACED",       // BET_PLACED | BET_VOIDED | PAYOUT |
                                    // CASH_ADVANCE | REMIT | BET_REFUNDED
      "amount": "500.00"            // signed: + into drawer, − out of drawer
    }
  },
  "ts": "..."
}
```

**Recipient model:**

This is a **global broadcast** — every connected socket receives every
frame. The admin dashboard renders all of them. **Teller kiosks drop any
frame whose `tellerId !== self.id`**; for their own id, they're already
updating from the API response (see "Teller-side local balance update"
below), so they can drop those too. Broadcasting unconditionally is
cheaper than maintaining role-routing plumbing at LAN scale.

### Teller-side local balance update (no extra frame)

Every endpoint that appends to TellerLedger **also returns the actor's
new running balance** in its response body, under `actorBalance`:

```json
{
  "bet":   { ... },
  "fight": { ... },
  "actorBalance": "5250.00",
  "replay": false
}
```

The teller's kiosk reads `actorBalance` from every response and
overwrites its header. The kiosk never needs `TELLER_BALANCE_UPDATED`
to track its own number — only the admin dashboard does.

**Cash advances are the one exception** (admin initiates, teller is
passive). The teller has no response to read, but they're physically
present with the collector when the cash changes hands — they know
the new balance. A page refresh syncs the digital number when needed.

### 9. `TELLER_COMMISSIONS_UPDATED`

Fires after every fight transition that mutates realized commission:
`FIGHT_SETTLED`, `FIGHT_CANCELLED`, `FIGHT_CORRECTED`. Tells the admin
dashboard "your per-teller commission leaderboard is out of date —
refetch `/reports/teller-commissions` with whatever filter scope you're
currently viewing."

We intentionally do NOT carry the leaderboard inline. The dashboard's
view may be scoped to a single fight, a date range, or active tellers
only — the broadcast can't know which. Pushing only the trigger metadata
keeps the wire contract decoupled from the report's projection shape.

```json
{
  "type": "TELLER_COMMISSIONS_UPDATED",
  "data": {
    "trigger":     "FIGHT_SETTLED",
    "fightId":     "...",
    "fightNumber": 1042
  },
  "ts": "..."
}
```

`trigger` is one of: `FIGHT_SETTLED`, `FIGHT_CANCELLED`, `FIGHT_CORRECTED`.

### 10. `SESSION_RESET`

Fires once after `POST /session/reset` commits. Tells every connected
kiosk that the entire transactional state (`Fight`, `Bet`,
`TellerLedger`) has just been wiped. Clients should clear their local
state — current fight, balance display, ticket history, recent activity
— and re-fetch a fresh snapshot.

```json
{
  "type": "SESSION_RESET",
  "data": {
    "sessionResetId":      "...",
    "performedAt":         "2026-05-12T01:42:00.000Z",
    "performedByUserId":   "...",
    "performedByUsername": "admin",
    "deletedCounts": {
      "fights": 12,
      "bets":   145,
      "ledger": 230
    },
    "forced": false
  },
  "ts": "..."
}
```

The frame carries `sessionResetId` so a kiosk that reconnects mid-broadcast
and sees the same event twice can dedupe.

We do NOT forcibly close WS connections after a reset — clients keep
their socket and resume receiving frames against the now-empty state.
The frame itself is the trigger to refresh; the transport stays.

---

## Things explicitly NOT broadcast (and why)

| Event | Why it stays REST-only |
|---|---|
| Bet placed / voided / paid (admin activity feed) | Admin can refresh the bets page; sub-second visibility of individual bets isn't needed (the per-teller balance roll-up is broadcast instead). |
| Cash adjustment | Endpoint does not exist by policy. No manual balance edits. |
| User deactivated | The deactivated user's next REST call will return 401 — sufficient. |
| Setting (commission rate) changed | Only affects future fights; admin sees it on refresh. |
| Collectors changed | Admin sees it on refresh. |

If any of these turn out to be operationally painful, we promote them
into the catalog — but not before.

---

## Endpoint → broadcast wiring (the truth table)

| Endpoint | Broadcasts emitted on commit |
|---|---|
| `POST /bets` ✅ | `ODDS_UPDATE` + `TELLER_BALANCE_UPDATED` ✅ |
| `POST /bets/{id}/void` ✅ | `ODDS_UPDATE` + `TELLER_BALANCE_UPDATED` ✅ |
| `POST /bets/{id}/pay` ✅ | `TELLER_BALANCE_UPDATED` ✅ |
| `POST /cash/advances` ✅ | `TELLER_BALANCE_UPDATED` ✅ |
| `POST /cash/remits` ✅ | `TELLER_BALANCE_UPDATED` ✅ |
| `POST /fights` (creates + opens in one shot) | `FIGHT_OPENED` |
| `POST /fights/{id}/close` | `FIGHT_CLOSED` |
| `POST /fights/{id}/settle` | `FIGHT_SETTLED` + `TELLER_COMMISSIONS_UPDATED` ✅ |
| `POST /fights/{id}/cancel` | `FIGHT_CANCELLED` + `TELLER_COMMISSIONS_UPDATED` ✅ |
| `POST /fights/{id}/correct` | `FIGHT_CORRECTED` + `TELLER_COMMISSIONS_UPDATED` ✅ |
| `POST /fights/{id}/sides/{side}/hold` | `SIDE_HELD` |
| `POST /fights/{id}/sides/{side}/unhold` | `SIDE_UNHELD` |
| `POST /session/reset` ✅ | `SESSION_RESET` ✅ |

All TellerLedger-mutating endpoints additionally include `actorBalance`
in the HTTP response body so teller kiosks can self-update.

**Rule** (already followed by `placeBet` / `voidBet`): broadcasts fire
**after** the Prisma transaction commits, never inside it. A WS failure
must not be able to roll back a real money movement.

---

## Required WS-plugin changes (small)

Today the plugin tracks clients as `Set<WebSocket>` and exposes
`app.broadcastOdds(payload)`. To support the catalog above we only need:

1. **Generic helper** `app.broadcast(frame)` that fans `frame` out to every
   socket. Keep `broadcastOdds` as a thin alias for backward compatibility
   (it just calls `broadcast` with an `ODDS_UPDATE` envelope).
2. **`WELCOME` frame** sent inside the existing connection handler, after
   JWT validation succeeds.
3. **`PING` / `PONG`** keepalive loop on each socket.

That's it. No per-user routing, no role filtering, no topic subscriptions.

---

## Implementation order (when we build Fights)

1. Harden the WS plugin (generic `broadcast`, `WELCOME`, `PING`/`PONG`).
2. Build the Fights endpoints in `src/modules/fights/` — each handler
   calls `app.broadcast(...)` AFTER its transaction commits, using the
   payload shapes above.
3. Update `scripts/ws-listener.mjs` (the dev sniffer) to pretty-print
   each event type so future debugging is fast.
