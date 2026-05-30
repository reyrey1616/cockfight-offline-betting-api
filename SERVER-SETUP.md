# Server setup (LAN)

**Multiple computers:** This guide is for the **one server PC**. Teller kiosks are **other machines** on the LAN — they only run the Electron app and connect here. See [../MULTI-COMPUTER.md](../MULTI-COMPUTER.md).

One PC runs the database, API, and admin browser. Teller kiosks (5–10+ separate PCs) only run **Cockfight Betting Kiosk**.

## 1. Prerequisites

- Node.js 20+
- PostgreSQL (local on server PC)

## 2. Configure API

```bash
cd cockfigh-offline-betting-api
cp .env.example .env
```

Edit `.env`:

- `DATABASE_URL` — your Postgres connection
- `PORT=8000` — API port (default)
- `JWT_SECRET` — change for production
- `CORS_ORIGINS` — optional; add admin browser origin if needed

## 3. Database

```bash
npm install
npx prisma generate
npx prisma db push   # or: npm run db:migrate
npm run seed         # creates admin user (see .env SEED_ADMIN_PASSWORD)
```

## 4. Start API (always on during operation)

```bash
npm run dev
# or production:
npm run start
```

API listens on **`0.0.0.0:8000`** — reachable from other PCs on the LAN.

## 5. Note the server LAN IP

On the server machine:

- **macOS:** System Settings → Network → IP address (e.g. `192.168.1.6`)
- **Windows:** `ipconfig` → IPv4 Address

**Every** kiosk PC on the LAN will use: `http://<that-ip>:8000` (identical `apiBaseUrl` in each kiosk’s `config.json`).

## 6. Admin (on server PC)

**Development:**

```bash
cd ../cockfight-offline-betting-machine-client
npm install
# .env.development — VITE_API_BASE_URL=http://localhost:8000 or auto
npm run dev
```

Open `http://localhost:5173` → login as admin → Operate fights, settings, etc.

**Production:** optional — serve `machine-client/dist` or keep using `npm run dev` on server only.

## 7. Firewall

Allow inbound **TCP 8000** on the server from the LAN subnet.

## 8. Verify from another PC (or phone on same Wi‑Fi)

```bash
curl http://192.168.1.6:8000/documentation
```

Replace with your server IP. Should return HTML (Swagger UI) or JSON, not connection refused.

## 9. Electron kiosks (CORS)

Packaged teller apps load the UI from `http://127.0.0.1` on each kiosk and call this API over the LAN. Current API builds allow that origin automatically. After pulling API updates, **restart** the API process so sign-in from kiosks is not blocked by CORS.
