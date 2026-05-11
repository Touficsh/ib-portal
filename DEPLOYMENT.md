# Going-live Runbook

The portal currently runs on **localhost** on this VPS. This document is
the step-by-step recipe for putting it on the public internet under a
proper HTTPS domain.

Total realistic time: **3-4 hours**, mostly waiting on DNS + Let's Encrypt.

---

## Prerequisites

Before you start, have these ready:

- **A domain name you control** (or can edit DNS for), e.g.
  `portal.bbcorp.trade` — usually a subdomain of an existing brand domain.
- **Access to the VPS provider's firewall console** (if they have one
  separate from Windows Firewall). Hetzner, AWS, GCP, DigitalOcean all
  expose this in their dashboard.
- **An admin PowerShell on this VPS.** Several of these steps need
  elevated permissions.
- **30 minutes of uninterrupted attention** for the actual cutover —
  don't start at 4:55 PM on a Friday.

---

## Step 1 — Domain + DNS (5 min + propagation wait)

1. Decide the subdomain. Common patterns: `portal`, `agents`, `ib`.
2. In your DNS provider's dashboard, add an **A record**:
   - Host: `portal` (or your chosen subdomain)
   - Type: `A`
   - Value: `46.252.194.194` (this VPS's public IP)
   - TTL: 300 seconds (5 min) is fine

3. Verify the DNS resolves:
   ```powershell
   nslookup portal.bbcorp.trade
   # Should return 46.252.194.194 within a few minutes.
   ```

Wait for `nslookup` to return the right IP before proceeding. Sometimes
takes 5 minutes, sometimes 30. **Do not start step 3 (Caddy/TLS) until
DNS resolves** — Let's Encrypt will fail.

---

## Step 2 — Open the firewall (5 min)

### Windows Firewall

```powershell
# Run as Administrator
New-NetFirewallRule -DisplayName "HTTP"  -Direction Inbound -LocalPort 80  -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "HTTPS" -Direction Inbound -LocalPort 443 -Protocol TCP -Action Allow

# Make sure 3001 and 5555 stay closed to the public (only localhost).
# They should already be — verify with:
Get-NetFirewallRule -DisplayName "*" | Where-Object {
    ($_.Enabled -eq 'True') -and ($_.Direction -eq 'Inbound')
} | Select-Object DisplayName
```

### Cloud firewall (if your VPS provider has one)

Most providers have a separate firewall layer in their dashboard.
Open 80 + 443 inbound there too. Leave 3001 and 5555 closed
(they should default to closed; double-check).

### Verify

From your laptop (NOT this VPS — you need an external client):

```bash
nc -zv portal.bbcorp.trade 443
# Or: curl -v https://portal.bbcorp.trade  (will fail TLS until step 3)
# Just need "Connected to portal..."
```

If that times out, the firewall is still blocking. Fix before
continuing.

---

## Step 3 — Install Caddy + auto-HTTPS (15 min)

Caddy is a single .exe that handles TLS termination, Let's Encrypt
certificate issuance, automatic renewal, and reverse-proxying — with
basically zero configuration.

### Install

```powershell
# Download the latest Windows release of Caddy
$caddyDir = "C:\Caddy"
New-Item -ItemType Directory -Force -Path $caddyDir
Invoke-WebRequest `
    -Uri "https://caddyserver.com/api/download?os=windows&arch=amd64" `
    -OutFile "$caddyDir\caddy.exe"
```

### Configure

Create `C:\Caddy\Caddyfile` with this content (replace the domain):

```caddy
portal.bbcorp.trade {
    # Reverse proxy everything to the portal backend on localhost
    reverse_proxy localhost:3001

    # Security headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options    "nosniff"
        X-Frame-Options           "DENY"
        Referrer-Policy           "strict-origin-when-cross-origin"
    }

    # Log file (rotated automatically by Caddy)
    log {
        output file C:\Caddy\access.log {
            roll_size 100mb
            roll_keep 7
        }
    }
}
```

### Test the config

```powershell
cd C:\Caddy
.\caddy.exe validate --config Caddyfile
# Should print: "Valid configuration"
```

### Run it once interactively to verify TLS issuance

```powershell
.\caddy.exe run --config Caddyfile
# Watch the output. Caddy will:
#   - Bind 80 and 443
#   - Solve the ACME HTTP-01 challenge for Let's Encrypt
#   - Get a cert
#   - Start proxying
```

If you see `serving initial configuration` and no errors, hit
`https://portal.bbcorp.trade` from your laptop — you should see the
portal's login page over HTTPS.

If it fails:
- "challenge failed" → DNS isn't fully propagated yet, wait
- "permission denied :80" → not running as Administrator
- "tcp accept failed" → firewall not open, see step 2

Ctrl+C to stop. Next step makes it permanent.

### Make Caddy a service

```powershell
# Caddy can run itself as a service via the windows-service plugin,
# OR you can wrap with NSSM (see step 5). Quickest: built-in.
.\caddy.exe service install --config "C:\Caddy\Caddyfile"
sc start Caddy
```

Verify it auto-starts on reboot:

```powershell
sc qc Caddy | findstr "START_TYPE"
# Should say "AUTO_START"
```

---

## Step 4 — Update portal config for the public URL (5 min)

Edit `C:\ib-portal\backend\.env`:

```diff
- FRONTEND_URL=http://localhost:5201
+ FRONTEND_URL=https://portal.bbcorp.trade
```

This controls CORS — without it, the browser blocks login requests
from the public domain.

Restart the portal so it picks up the new env var. (If you've done
step 5 already, this is `sc restart IBPortalBackend`. Otherwise,
kill the node process and re-launch via Task Scheduler.)

### Other things to double-check at this step

- `JWT_SECRET` — ≥ 32 chars random. Generate fresh if you ever
  suspect leak:
  ```powershell
  node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
  ```
- `SYNC_WEBHOOK_SECRET` — confirmed rotated to `c37ff030...`. If you
  need to rotate again, regenerate the same way and share with xdev.
- `MT5_WEBHOOK_SECRET` — internal-only (bridge ↔ portal on localhost).
  Don't expose externally.
- `DATABASE_URL` — Supabase connection string with strong password.

---

## Step 5 — Convert Task Scheduler → Windows Services via NSSM (30 min)

Today's auto-start runs at user logon. **That's fragile**: if no one
is logged in (e.g. after an unattended reboot), nothing starts.
Production wants services that start at *boot*, regardless of login,
and auto-restart on crash.

### Install NSSM

[Download NSSM](https://nssm.cc/release/nssm-2.24.zip), extract the
64-bit `nssm.exe` to `C:\nssm\nssm.exe`.

### Register the portal backend

```powershell
# Run as Administrator
cd C:\nssm

.\nssm.exe install IBPortalBackend "C:\Program Files\nodejs\node.exe"
.\nssm.exe set IBPortalBackend AppParameters     "src\server.js"
.\nssm.exe set IBPortalBackend AppDirectory      "C:\ib-portal\backend"
.\nssm.exe set IBPortalBackend AppStdout         "C:\ib-portal\backend-run.log"
.\nssm.exe set IBPortalBackend AppStderr         "C:\ib-portal\backend-err.log"
# Rotate logs at 50MB, keep 5
.\nssm.exe set IBPortalBackend AppStdoutCreationDisposition  4
.\nssm.exe set IBPortalBackend AppStderrCreationDisposition  4
.\nssm.exe set IBPortalBackend AppRotateFiles    1
.\nssm.exe set IBPortalBackend AppRotateBytes    52428800
# Start automatically at boot
.\nssm.exe set IBPortalBackend Start             SERVICE_AUTO_START
# Restart on crash with 5s delay
.\nssm.exe set IBPortalBackend AppRestartDelay   5000

sc start IBPortalBackend
```

Verify:

```powershell
Get-Service IBPortalBackend | Select-Object Name, Status, StartType
# Should be Running / Automatic
curl http://localhost:3001/api/health
```

### Register the bridge

```powershell
.\nssm.exe install MT5Bridge powershell.exe `
    "-NoProfile -ExecutionPolicy Bypass -File C:\ib-portal\mt5-bridge\start-bridge.ps1"
.\nssm.exe set MT5Bridge AppDirectory   "C:\ib-portal\mt5-bridge"
.\nssm.exe set MT5Bridge AppStdout      "C:\ib-portal\mt5-bridge\bridge-run.log"
.\nssm.exe set MT5Bridge AppStderr      "C:\ib-portal\mt5-bridge\bridge-err.log"
.\nssm.exe set MT5Bridge Start          SERVICE_AUTO_START
.\nssm.exe set MT5Bridge AppRestartDelay 5000
# Bridge depends on the portal being up (it fetches creds from /api/settings/mt5/internal)
.\nssm.exe set MT5Bridge DependOnService IBPortalBackend

sc start MT5Bridge
```

### Remove the old Task Scheduler entries

```powershell
Unregister-ScheduledTask -TaskName 'IBPortalAutoStart'   -Confirm:$false
Unregister-ScheduledTask -TaskName 'MT5BridgeAutoStart' -Confirm:$false
```

Now reboot the VPS (after-hours; agents won't be able to use the
portal during the ~60s reboot). On boot, both services start
automatically regardless of whether anyone logs in. NSSM auto-restarts
either if they crash.

---

## Step 6 — Production hardening (1 hour)

### Graceful shutdown on the portal

The Node backend doesn't currently handle SIGTERM cleanly — if NSSM
stops it mid-cycle, in-flight commission writes may not finish.

Add to `backend/src/server.js` near the bottom:

```javascript
function shutdown(signal) {
  console.log(`[Shutdown] ${signal} received, draining…`);
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
  // Hard exit after 10s if cleanup hangs
  setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

### Off-site database backup (weekly)

Supabase has Point-in-Time Recovery on Pro plan, but verify with a
backup-restore drill. Additional safety: a weekly `pg_dump` to a
separate location.

```powershell
# Save as C:\ib-portal\scripts\weekly-backup.ps1
$ts = Get-Date -Format "yyyy-MM-dd_HHmm"
$out = "C:\backups\ib-portal-$ts.dump"
$env:PGPASSWORD = $env:DATABASE_PASSWORD
pg_dump -h db.dltctvlubabxzyibxgkt.supabase.co -U postgres -d postgres -Fc -f $out
# Upload to S3/Backblaze/wherever:
# aws s3 cp $out s3://your-backup-bucket/
```

Schedule via Task Scheduler, weekly, 4 AM UTC.

### CSP + Referrer headers

Already handled by the Caddyfile above. Verify with:
```bash
curl -I https://portal.bbcorp.trade/portal/
# Should see Strict-Transport-Security, X-Content-Type-Options, etc.
```

### Bridge IP whitelist — periodic re-verification

The broker maintains an allow-list of IPs that can connect to the MT5
manager API. If the VPS IP ever changes, you'll see
`MT_RET_ERR_NETWORK` and need to re-engage the broker.

Periodically (monthly?) confirm:
```powershell
(Invoke-WebRequest -Uri https://api.ipify.org).Content
# Should always return 46.252.194.194
```

---

## Step 7 — Cutover (10 min)

1. **Test from outside the VPS** (your laptop, on cellular, off your office network):
   - `https://portal.bbcorp.trade/portal/` — should load
   - Log in with your admin account
   - Open Admin → System Health — bridge connected, deal stream
     flowing, schedulers ticking

2. **Test the agent flow**: log in as a real agent account, see their
   Dashboard, Summary, Commissions. Confirm auto-refresh works and
   the privacy redaction shows correctly.

3. **Test on a fresh browser / incognito** for a clean session.

4. **Share the URL with one pilot agent**. Watch System Health for 24 hours.

5. **Full rollout**: send the URL to all agents with the
   `OWNER_HANDBOOK.md` for context.

---

## Post-cutover — keep an eye on these

- **System Health** → Real-time deal stream → "Last 5 min" stays > 0 during broker hours
- **System Health** → Background schedulers → next-run countdowns advance normally
- **Audit Log** → `portal.me.privacy.update` events as sub-agents play with the privacy toggle
- **NSSM** service status: `Get-Service IBPortalBackend, MT5Bridge`
- **Caddy** access log: `Get-Content C:\Caddy\access.log -Tail 50`
- **Caddy** cert renewal: certs auto-renew at 30 days remaining. Confirm
  after ~60 days by checking the expiry: `openssl s_client -connect portal.bbcorp.trade:443 < /dev/null 2>/dev/null | openssl x509 -noout -dates`

---

## Rollback

If something goes wrong post-cutover and you need to back out:

```powershell
# Stop the services
sc stop MT5Bridge
sc stop IBPortalBackend
sc stop Caddy

# Re-enable the old Task Scheduler entries from earlier (they were unregistered in step 5).
# Use the commands from the earlier session.

# Reboot to confirm clean state.
Restart-Computer
```

The portal will be back on `http://localhost:3001/portal/` only,
agents won't be able to reach it from outside. Diagnose, fix, redo
the relevant step.

---

## What this DOES NOT cover

- **High availability** (multiple portal instances behind a load balancer)
- **Database failover** (Supabase handles this internally on Pro)
- **CDN** for the static frontend (Caddy is fine for a single-VPS deploy)
- **Email-on-error alerting** — see the deferred "notifications" item
  in the audit; not part of going-live but recommended early on
