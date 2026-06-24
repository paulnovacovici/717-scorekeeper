# Seven One Seven Agent Guide

This file is the operational source of truth for agents working in this repository. Keep infrastructure changes reflected here and in `README.md`.

## Application

- Project root: `/home/paul/projects/717-scorekeeper`
- Runtime: Node.js 22 or newer, CommonJS, no production npm dependencies
- Entry point: `server.js`
- Static client: `public/`
- Database code and migrations: `src/db.js`
- Tests: `test/db.test.js`
- Default local port: `7170`
- Health endpoint: `/healthz`
- Production URL: `https://717.novacovici.dev`

The production process binds only to `127.0.0.1:7170`. Do not change it to `0.0.0.0`; Cloudflare Tunnel is the only public ingress. Plain HTTP requests received through Cloudflare are redirected to the fixed HTTPS hostname.

## Data

- Live SQLite database: `data/717.db`
- SQLite uses foreign keys, WAL mode, `synchronous=NORMAL`, and a five-second busy timeout.
- Runtime WAL files are `data/717.db-wal` and `data/717.db-shm`.
- Daily backups: `data/backups/717-<timestamp>.db`
- Backup retention: 14 days
- Backup command: `npm run backup`

Active games use `game_rounds` for hand number, card count, direction, first caller, and completion state. The browser keeps the current hand's bids and exact-hit flags locally, then submits them with the active round ID to `/round/complete`; `round_bids` stores that completed hand atomically. Retrying the same completed round ID with the same bids is idempotent. Undoing the latest completed hand reopens that round with its saved bids. `game_scores` is the running total; completed hits are also written to `score_events` for compatibility with historical data.

## Game Rules

- A standard game has 13 hands with card counts `7, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 7`.
- Direction is `down` through hand 7 and `up` through hand 13.
- First caller rotates to the next group member after every completed hand. The UI permits correcting the caller before completion.
- Every player must choose a bid from zero through the current card count before the hand can complete.
- An exact hit scores `10 + bid^2`; a miss scores zero. Changing a bid clears its hit flag.
- After hand 13, a unique leader wins. A tie creates additional seven-card tiebreaker hands until there is a unique leader.

Round write endpoints are `POST /api/games/:id/round/caller`, `/round/complete`, and `/round/undo`. The UI changes bids and hit flags without a request and sends the full draft to `/round/complete`. Every POST handler with a request body must consume it before responding; WebKit can stall a keep-alive connection when a body is left unread.

Never replace or delete the live database, WAL, or SHM files while the application service is running. Before a manual restore, stop the application, preserve the current database, replace the database from a verified backup, remove stale WAL/SHM files, restore ownership and mode, and start the service again.

## Systemd

Checked-in unit templates live in `deploy/`. Installed units live in `/etc/systemd/system/`.

- `717-scorekeeper.service`: Node application
- `cloudflared-717.service`: Cloudflare connector
- `717-scorekeeper-backup.service`: one-shot SQLite backup
- `717-scorekeeper-backup.timer`: persistent daily backup timer

All three long-lived units are enabled at boot. The application and connector run as `paul`, use systemd sandboxing, and are separated with mount namespace rules:

- Node cannot read `~/.cloudflared`, `~/.ssh`, or `~/.gnupg`.
- cloudflared cannot read the application `data/` directory, `~/.ssh`, or `~/.gnupg`.
- Only the application `data/` directory is writable by the Node service.

Useful commands:

```bash
systemctl status 717-scorekeeper.service cloudflared-717.service --no-pager
systemctl is-active 717-scorekeeper.service cloudflared-717.service 717-scorekeeper-backup.timer
systemctl list-timers 717-scorekeeper-backup.timer --no-pager
journalctl -u 717-scorekeeper.service -u cloudflared-717.service -n 100 --no-pager
systemd-analyze security 717-scorekeeper.service cloudflared-717.service --no-pager
```

Do not launch a second `npm start` process while systemd owns port `7170`.

## Deploying Changes

For application-only changes:

```bash
cd /home/paul/projects/717-scorekeeper
npm test
sudo systemctl restart 717-scorekeeper.service
curl -fsS http://127.0.0.1:7170/healthz
curl -fsS https://717.novacovici.dev/healthz
```

Static files are read from the working tree. Restart the application when `server.js`, database code, environment settings, or MIME mappings change. A restart is not technically required for ordinary HTML, CSS, JavaScript, or image changes, but public verification is still required.

When a checked-in unit changes, install that exact file and reload systemd:

```bash
sudo install -m 0644 deploy/717-scorekeeper.service /etc/systemd/system/717-scorekeeper.service
sudo install -m 0644 deploy/cloudflared-717.service /etc/systemd/system/cloudflared-717.service
sudo install -m 0644 deploy/717-scorekeeper-backup.service /etc/systemd/system/717-scorekeeper-backup.service
sudo install -m 0644 deploy/717-scorekeeper-backup.timer /etc/systemd/system/717-scorekeeper-backup.timer
sudo systemctl daemon-reload
sudo systemctl restart 717-scorekeeper.service cloudflared-717.service
sudo systemctl enable --now 717-scorekeeper-backup.timer
```

Verify installed units still match the repository with `cmp -s deploy/<file> /etc/systemd/system/<file>`.

## Cloudflare Tunnel

- Tunnel name: `717-scorekeeper`
- Tunnel ID: `7a064400-1291-4d47-b7e6-6bd2d17b8865`
- Public hostname: `717.novacovici.dev`
- Origin: `http://127.0.0.1:7170`
- Config: `deploy/cloudflared-717-config.yml`
- Credentials: `/home/paul/.cloudflared/717-scorekeeper.json`
- Connector binary: `/usr/local/bin/cloudflared`
- DNS: proxied CNAME managed by `cloudflared tunnel route dns`

The credentials file is secret, mode `0400`, and must never be committed, printed, copied into documentation, or exposed to the Node service. The ingress config must end with the `http_status:404` catch-all.

Validate or inspect the tunnel with:

```bash
cloudflared --config deploy/cloudflared-717-config.yml tunnel ingress validate
cloudflared tunnel info 717-scorekeeper
dig +short 717.novacovici.dev @1.1.1.1
```

QUIC buffer tuning is checked in at `deploy/99-cloudflared-udp-buffer.conf` and installed at `/etc/sysctl.d/99-cloudflared-udp-buffer.conf`. The configured receive and send maximums are both `7500000`.

## Security And Public Access

The server sets a restrictive Content Security Policy, HSTS, clickjacking protection, MIME sniffing protection, a permissions policy, request/header timeouts, and graceful shutdown handlers. Cloudflare terminates TLS and the origin is not directly exposed.

The application currently has no login or authorization layer. Anyone who can reach the public hostname can use write operations, including changing bids, completing rounds, and deleting games. Adding Cloudflare Access requires an explicit allowed-identity policy and is the preferred next step if access should be private.

## Verification Gates

Before considering a production change complete:

1. Run `npm test` and `npm audit --omit=dev`.
2. Confirm application, tunnel, and backup timer are active.
3. Confirm `http://717.novacovici.dev` redirects to HTTPS.
4. Confirm `https://717.novacovici.dev/healthz` returns `{"ok":true}`.
5. Load the public site in a browser at mobile width and check for console or failed-network errors after UI or asset changes.
6. Confirm persisted scores and win/loss records still match through `/api/groups/1` after database or deployment changes.
7. For round-flow changes, verify bid selection, hit outlines, round completion, caller rotation, and the next card count in mobile WebKit.
8. Check recent journals for unexpected startup errors.

The SVG favicon source is `public/favicon.svg`. The Open Graph vector source is `public/og-seven-one-seven.svg`; its crawler-compatible 1200x630 PNG is `public/og-seven-one-seven.png`. If either SVG changes, regenerate and verify its raster derivative.
