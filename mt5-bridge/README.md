# MT5 Bridge

A small .NET 8 web service that connects to the broker's MetaTrader 5
Manager API and:

1. **Streams deals in real-time** to the IB Portal via webhook
   (`POST /api/mt5/webhook/deal`) — usually within 1 second of execution.
2. **Serves on-demand bridge endpoints** that the portal calls when it
   needs a single login's account/history/transactions/positions.
3. **Auto-recovers** from MT5 disconnects via a 30-second background
   reconnect loop.

The bridge is intentionally narrow in scope: it owns nothing, persists
nothing, and is replaceable. Portal is the only consumer.

## Architecture

```
┌────────────────────┐                    ┌────────────────────┐
│ Broker MT5 server  │                    │   IB Portal        │
│ (Manager API)      │                    │   (Express, :3001) │
└─────────┬──────────┘                    └────────────┬───────┘
          │                                            │
          │ Manager API TCP (persistent + DealSubscribe)
          │                                            │
          ▼                                            │
┌────────────────────┐   POST /api/mt5/webhook/deal    │
│   MT5 Bridge       │ ──────────────────────────────► │
│   (this app)       │                                 │
│   :5555            │ ◄────────────────────────────── │
│                    │   GET /accounts/:login          │
└────────────────────┘   GET /history/:login           │
                         GET /transactions/:login      │
                         GET /positions/:login         │
                         POST /connect                 │
                         POST /reconnect               │
                         GET  /health                  │
```

For the portal-side architecture see
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) (§ 3.2 *MT5 bridge*).

## Build prerequisites

- **.NET 8 SDK** (Windows; the bridge targets `net8.0-windows`)
- **MetaQuotes MT5 Manager API SDK** installed at `C:\MetaTrader5SDK\`
  (the `.csproj` references DLLs under `C:\MetaTrader5SDK\Libs\`).
  Get this from MetaQuotes — typically supplied by your broker as part
  of their Manager API onboarding.

## Build

```powershell
dotnet build -c Release
```

Outputs `bin/Release/net8.0-windows/mt5-bridge.exe` plus the native
MT5 manager DLLs (copied from the SDK at build time).

## Run

**Always launch via `start-bridge.ps1`**, not the .exe directly.
The script:

1. Reads `MT5_WEBHOOK_SECRET` from `../backend/.env` (single source of truth)
2. Sets `CRM_BACKEND_URL=http://localhost:3001` so the bridge can fetch
   MT5 manager credentials from the portal on startup
3. Stops any running bridge process
4. Launches a fresh one with logs to `bridge-run.log` / `bridge-err.log`
5. Verifies `/health` came up

```powershell
pwsh C:\ib-portal\mt5-bridge\start-bridge.ps1
```

## Auto-start at logon

Registered as a Windows Task Scheduler entry called `MT5BridgeAutoStart`.
Triggers: at logon, 90-second delay (so the portal backend
`IBPortalAutoStart` is up first). See
[`../OPERATIONS_GUIDE.md`](../OPERATIONS_GUIDE.md) for the registration
command and troubleshooting steps.

## Configuration

The bridge needs to know:

| What | Where it comes from |
|---|---|
| MT5 manager credentials (server, port, login, password) | Portal admin → Settings → "MT5 Manager API". Bridge fetches via `GET /api/settings/mt5/internal` (localhost-only). |
| Server timezone offset (broker uses local time, not UTC) | Same Settings page → "MT5 Server TZ Offset". Default 3 (UTC+3). |
| Webhook secret (HMAC-style header for outbound deal POSTs) | `backend/.env` → `MT5_WEBHOOK_SECRET`. Read by the launcher. |
| Source-IP whitelist on the broker's manager endpoint | Configured by the broker. The bridge's outbound IP must be on the broker's allow-list — most brokers gate Manager API traffic this way. |

## Source files

- `Program.cs` — top-level. Manager API setup, sink registration order
  (`RegisterSink()` before `Subscribe()`), reconnect loop, HTTP endpoints,
  `DealSink` + `MgrSink` classes.
- `mt5-bridge.csproj` — references to MetaQuotes' DLLs.
- `appsettings.json` — minimal ASP.NET Core config.
- `start-bridge.ps1` — launcher.

## Things to know that bit us during integration

These are non-obvious gotchas in the MT5 C# wrapper. All addressed in
`Program.cs`; comments call them out at the relevant lines:

1. **`RegisterSink()` must be called on each sink BEFORE
   `manager.Subscribe()` / `manager.DealSubscribe()`.** Without it, those
   calls return `MT_RET_ERR_PARAMS` because the C# wrapper's native
   callable wrapper isn't initialized.
2. **Manager-level `Subscribe()` must be called BEFORE per-event
   subscribes** (`DealSubscribe`). Same `MT_RET_ERR_PARAMS` failure
   if you skip it.
3. **All subscribes happen ONCE at startup, BEFORE the first
   `Connect()`.** They persist across reconnects — do not re-subscribe.
4. **`deal.Time()` returns broker-local seconds**, not UTC. The portal
   subtracts the configured `mt5_server_tz_offset_hours` before storing.
5. **Source-IP whitelisting** at the broker is the most common
   "MT_RET_ERR_NETWORK" cause. TCP connects fine but the protocol
   handshake is rejected.
6. **The C# `EnPumpModes` enum only exposes `PUMP_MODE_FULL`** (no
   granular `PUMP_MODE_DEALS`/`USERS`). The C++ SDK has more flags;
   not worth the rewrite.
