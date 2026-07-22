# FlightWatch

Track a flight number and get pushed a notification when its status changes (departure or arrival side).

## Stack
- **Frontend:** static PWA (Cloudflare Pages) — enter a flight, see live status
- **Backend:** Cloudflare Worker — cron polls AeroDataBox every 5 min, diffs status, stores state in Workers KV
- **Notifications:** [ntfy.sh](https://ntfy.sh) — Worker POSTs a plain message when status changes, ntfy's app pushes it to your phone
- **Flight data:** [AeroDataBox](https://aerodatabox.com/) via RapidAPI (free tier)

No Web Push/VAPID, no webhooks, no credit-based alerts — just a cheap poll and a plain HTTP POST.

## Setup

1. **Accounts**
   - GitHub account
   - Cloudflare account
   - RapidAPI account → subscribe to AeroDataBox (free tier), grab API key
   - Install the [ntfy app](https://ntfy.sh) on your phone, pick a random unguessable topic name (e.g. `flightwatch-ag-x7k2p`)

2. **Local tools**
   ```
   npm install -g wrangler
   wrangler login
   ```

3. **Install deps**
   ```
   cd worker
   npm install
   ```

4. **Create KV namespace**
   ```
   wrangler kv namespace create FLIGHT_DATA
   ```
   Copy the returned `id` into `worker/wrangler.toml` under `kv_namespaces`.

5. **Set secrets**
   ```
   wrangler secret put AERODATABOX_KEY
   wrangler secret put NTFY_TOPIC
   ```

6. **Run locally**
   ```
   wrangler dev
   ```

7. **Deploy**
   ```
   wrangler deploy
   ```
   Connect the `public/` folder to Cloudflare Pages (via dashboard, linked to this GitHub repo) for the frontend.

## Project structure

```
FlightWatch/
├── public/              # PWA frontend (Cloudflare Pages)
│   ├── index.html
│   ├── app.js
│   ├── manifest.json
│   └── sw.js
└── worker/              # Cloudflare Worker (cron + API)
    ├── src/
    │   ├── index.ts     # fetch handler (REST API) + scheduled handler (cron)
    │   ├── aerodatabox.ts
    │   └── ntfy.ts
    ├── wrangler.toml
    ├── package.json
    └── tsconfig.json
```
