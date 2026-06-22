# Seven One Seven Scorekeeper

A mobile-friendly, dark-themed score tracker for recurring groups of card players. It tracks the 13-hand down-and-up sequence, first caller, bids, exact hits, running scores, and win/loss records in SQLite.

Each game runs through `7, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 7` cards. Players choose their bid and mark whether they hit it exactly; these choices stay in the browser until the hand is completed and saved atomically. Hits score `10 + bid²`, while misses score zero. First caller rotates automatically, and tied games continue with seven-card tiebreaker hands.

## Run

Requires Node.js 22.5 or newer.

```bash
npm start
```

Open `http://127.0.0.1:7170` locally, or use the machine's hostname from another device on the network. The server listens on all interfaces by default. The first run creates `data/717.db` and an Ellie + Paul starter group.

```bash
npm test
```

Set `PORT`, `HOST`, or `DB_PATH` to override the defaults.

## Production

Production runs as an unprivileged, sandboxed systemd service bound to `127.0.0.1:7170`. A dedicated Cloudflare Tunnel is the only public ingress and publishes `https://717.novacovici.dev`. SQLite remains in WAL mode with a five-second busy timeout, and a persistent systemd timer creates daily backups with 14-day retention.

Deployment files live in `deploy/`:

- `717-scorekeeper.service`: Node application
- `cloudflared-717.service`: dedicated Cloudflare Tunnel
- `717-scorekeeper-backup.service` and `.timer`: SQLite backups
- `cloudflared-717-config.yml`: hostname ingress and catch-all denial
- `99-cloudflared-udp-buffer.conf`: QUIC UDP buffer tuning

Useful checks:

```bash
systemctl status 717-scorekeeper.service cloudflared-717.service --no-pager
systemctl list-timers 717-scorekeeper-backup.timer
journalctl -u 717-scorekeeper.service -u cloudflared-717.service -n 100 --no-pager
curl -fsS https://717.novacovici.dev/healthz
```
