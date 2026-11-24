<img src="server/web/public/favicon.svg" alt="Uptarn" width="52" height="52" />

# Uptarn

Push-based monitoring hub built for Cloudflare Workers, unifying flexible node reporting, HTTP probes, and cron jobs.

Instead of running separate host, uptime, and cron monitors on a dedicated high-SLA server, Uptarn runs as a single edge service (or self-hosted SQLite) where any device pushes only the metrics, checks, charts, or job runs you care about over HTTPS.

## Comparison

Covering mixed personal devices (VPS, homelab, NAS, routers), web services, and scheduled backups usually requires deploying three separate tools on a reliable server you maintain yourself. Uptarn combines them into one edge deployment with an open push payload:

|                                           | Uptarn                                                                              | Host monitors (Beszel, Komari) | Uptime monitors (Uptime Kuma, Gatus) | Cron monitors (Healthchecks) |
| ----------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------ | ---------------------------- |
| **Hub hosting**                           | Cloudflare Workers + D1 (or Node + SQLite)                                          | Self-hosted server             | Self-hosted server                   | Self-hosted server or SaaS   |
| **Needs high-SLA monitor host**           | No (runs on Cloudflare edge)                                                        | Yes                            | Yes                                  | Yes (if self-hosted)         |
| **Host & device data**                    | Push any subset of metrics, mounts, checks, charts, or info via agent or HTTPS JSON | Fixed host agent metrics       | None                                 | None                         |
| **Heterogeneous devices (NAS / OpenWrt)** | Storage-only, shell scripts, or plain `curl` over outbound HTTPS                    | Expects full host agent        | N/A                                  | Cron pings only              |
| **HTTP probes & status page**             | Built in (with redacted public nodes)                                               | No                             | Yes                                  | No                           |
| **Scheduled job dead-man's switch**       | Built in (overdue alerts + failure logs)                                            | No                             | Basic push heartbeat                 | Yes                          |

## Deploy Hub (Cloudflare Workers + D1)

### One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/so1ve/uptarn/tree/main/server)

Cloudflare provisions the D1 database (`DB`), builds the dashboard, applies `migrations/`, and deploys the Worker. After deploying, update `PUBLIC_BASE_URL` and configure `ADMIN_PASSWORD`, `ADMIN_TOKEN`, and any optional alert/auth secrets (see [server/.dev.vars.example](server/.dev.vars.example)) in the Cloudflare dashboard or via Wrangler.

### Manual deploy

```sh
cd server
pnpm exec wrangler d1 create uptarn
# Update database_id and PUBLIC_BASE_URL in server/wrangler.jsonc

pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put ADMIN_TOKEN
# Optional IM channels:
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put MATRIX_ACCESS_TOKEN

pnpm run deploy
```

## Self-Hosting Hub (Node.js / Docker / NixOS)

```sh
export PUBLIC_BASE_URL=https://status.example.com
export ADMIN_PASSWORD_FILE=/run/secrets/uptarn-password
export ADMIN_TOKEN_FILE=/run/secrets/uptarn-admin-token

uptarn-server --host 0.0.0.0 --port 8787 --db /var/lib/uptarn/uptarn.db
```

Multi-arch (`linux/amd64`, `linux/arm64`) Hub images are published to `ghcr.io/so1ve/uptarn`:

```sh
docker run -d --name uptarn -p 8787:8787 -v uptarn-data:/data \
  -e PUBLIC_BASE_URL=https://status.example.com \
  -e ADMIN_PASSWORD=change-me \
  -e ADMIN_TOKEN=change-me \
  ghcr.io/so1ve/uptarn:latest
```

## Rust Agent (`uptarn-agent`)

Example `/etc/uptarn/agent.toml` for a NixOS host (`homelab`):

```toml
hub_url = "https://status.example.com"
node_id = "homelab"
label = "Homelab"
token_file = "/run/secrets/uptarn-homelab-token"
interval_secs = 60
grace_secs = 120

[[exec]]
key = "systemd"
label = "systemd"
group = "system"
command = [
  "sh",
  "-c",
  "u=$(systemctl list-units --state=failed --no-legend --plain | awk '{print $1}'); [ -z \"$u\" ] && echo '0 failed units' || { echo \"failed: $(echo \"$u\" | paste -sd, -)\"; exit 1; }",
]

[[mounts]]
path = "/"
label = "root"

[[mounts]]
path = "/srv/nas/data"
label = "NAS Data"
timeout_ms = 3000

[[tcp_probes]]
key = "tcp.edge"
label = "Edge Relay"
group = "network"
target = "edge.example.com:443"
count = 4

[[tls_certs]]
key = "tls.main"
label = "*.example.com TLS"
connect = "127.0.0.1:443"
server_name = "app.example.com"
warn_days = 14
fail_days = 5
```

Minimal DSM storage-only example:

```toml
hub_url = "https://status.example.com"
node_id = "dsm"
label = "Synology DSM"
token = "uptn_node_..."
interval_secs = 300
grace_secs = 300

[system]
cpu = false
memory = false
load = false
network = false
os_info = false

[[mounts]]
path = "/volume2"
label = "Volume 2"
```

OpenWrt router / dynamic collectors example with `[[exec]]` and `exec_dirs`:

```toml
hub_url = "https://status.example.com"
node_id = "router"
label = "OpenWrt"
token = "uptn_node_..."

# Automatically run any executable script dropped into this directory on each tick
# (JSON stdout emitting mounts/checks/series/info is parsed automatically; plain text falls back to exit-code check)
exec_dirs = ["/etc/uptarn/collectors.d"]

[[exec]]
key = "tailscale"
label = "Tailscale"
group = "network"
command = [
  "sh",
  "-c",
  "tailscale status --peers=false >/dev/null && echo connected",
]

[[exec]]
key = "wan6"
label = "WAN IPv6"
format = "json"
command = ["/etc/uptarn/check-wan6.sh"]
```

Wrap scheduled backups (Dead Man's Switch + failure stderr capture):

```sh
uptarn-agent run -c /etc/uptarn/agent.toml \
  --job homelab-restic \
  --label "Homelab Restic" \
  --every 24h \
  --grace 2h \
  -- restic-backups-homelab
```

Or run the agent via Docker (`ghcr.io/so1ve/uptarn-agent`, `linux/amd64` + `linux/arm64`):

```sh
docker run -d --name uptarn-agent --restart unless-stopped --net=host \
  -v /etc/uptarn/agent.toml:/etc/uptarn/agent.toml:ro \
  ghcr.io/so1ve/uptarn-agent:latest
```

## Nix Flake & NixOS Modules

- `packages.<system>.uptarn-server`: Self-hosted Hub HTTP server
- `packages.<system>.uptarn-agent`: Linux agent (`default` on Linux)
- `packages.<system>.uptarn-agent-static`: Static `musl` binary for Synology DSM and OpenWrt
- `nixosModules.default`: NixOS modules `services.uptarn` and `services.uptarn-agent`

## Releasing

Bump `server/package.json`, `Cargo.toml`, and `Cargo.lock` together, commit, and push a `v*.*.*` tag:

```sh
just release
```

## License

[MIT](LICENSE). Made by [Ray](https://github.com/so1ve) with ~~Tokens~~
