<picture>
  <source media="(prefers-color-scheme: dark)" srcset="web/public/logo-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="web/public/logo-light.svg" />
  <img src="web/public/logo-light.svg" alt="Uptarn" width="52" height="52" />
</picture>

# Uptarn

Push-based monitoring hub built for Cloudflare Workers, unifying flexible node reporting, HTTP probes, and cron jobs.

Instead of running separate host, uptime, and cron monitors on a dedicated high-SLA server, Uptarn runs as a single edge service (or self-hosted SQLite) where any device pushes only the metrics, checks, charts, or job runs you care about over HTTPS.

Try the **[Live Demo](https://so1ve.github.io/uptarn/)** (interactive browser mock with synthetic data).

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

Keep `wrangler.jsonc` unmodified so upstream binding and routing updates merge cleanly. Instance-specific values (`database_id`, custom domains, `PUBLIC_BASE_URL`) live either in GitHub repository variables, Cloudflare Dashboard variables (preserved via `keep_vars: true`), or a gitignored `wrangler.local.jsonc`.

### Fork + GitHub Actions (Recommended)

1. Fork this repository on GitHub and create a D1 database (`uptarn`) in your Cloudflare account.
2. Add **Repository Secrets** in your fork: `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1, and Account Settings edit permissions) and `CLOUDFLARE_ACCOUNT_ID`.
3. Add **Repository Variables** in your fork:
   - `UPTARN_DEPLOY` = `true`
   - `UPTARN_D1_DATABASE_ID` = `<your-d1-database-id>`
   - Optional: `UPTARN_CUSTOM_DOMAIN` (e.g. `status.example.com`), `UPTARN_PUBLIC_BASE_URL`, `UPTARN_WORKER_NAME`, `UPTARN_D1_DATABASE_NAME`
4. Run the **Deploy Worker** workflow once (or push to `main`).
5. Configure `ADMIN_PASSWORD` and `ADMIN_TOKEN` (and optional `CF_ACCESS_*` / `TURNSTILE_*` — see [.dev.vars.example](.dev.vars.example)) in Cloudflare Dashboard or via `wrangler secret put`. Alert thresholds, retention days, and Telegram / Matrix / Webhook channels can be configured directly in the Web UI under **Settings**.

### One-click deploy (Cloudflare Workers Builds)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/so1ve/uptarn)

Cloudflare provisions the D1 database (`DB`), builds the dashboard, and deploys the Worker. After the first deploy:

- Set `PUBLIC_BASE_URL` (plain-text variable) and `ADMIN_PASSWORD` / `ADMIN_TOKEN` (secrets) in the Cloudflare dashboard.
- Set the Workers Builds deploy command to `pnpm run deploy` so future builds automatically apply `migrations/` to D1 before deploying.

### Local CLI deploy (`wrangler.local.jsonc`)

```sh
pnpm exec wrangler d1 create uptarn
```

Create a gitignored `wrangler.local.jsonc` containing only your instance overrides:

```jsonc
{
  "d1_databases": [{ "binding": "DB", "database_id": "<your-d1-database-id>" }],
  "routes": [{ "pattern": "status.example.com", "custom_domain": true }],
  "vars": {
    "PUBLIC_BASE_URL": "https://status.example.com",
  },
}
```

Then configure secrets and deploy (`pnpm run deploy` merges `wrangler.jsonc` + `wrangler.local.jsonc`, builds `web/dist`, applies remote D1 migrations, and deploys):

```sh
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm run deploy
```

## Self-Hosting Hub (Node.js / Docker / NixOS)

```sh
export PUBLIC_BASE_URL=https://status.example.com
export ADMIN_PASSWORD_FILE=/run/secrets/uptarn-password
export ADMIN_TOKEN_FILE=/run/secrets/uptarn-admin-token

uptarn serve --host 0.0.0.0 --port 8787 --db /var/lib/uptarn/uptarn.db
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

[[mounts]]
path = "/"
label = "root"

[[mounts]]
path = "/srv/nas/data"
label = "NAS Data"
timeout_ms = 3000

# Node-attached collectors (type defaults to "exec"; also supports "tls" and "tcp").
[[collectors]]
key = "systemd"
label = "systemd"
group = "system"
command = [
  "sh",
  "-c",
  "u=$(systemctl list-units --state=failed --no-legend --plain | awk '{print $1}'); [ -z \"$u\" ] && echo '0 failed units' || { echo \"failed: $(echo \"$u\" | paste -sd, -)\"; exit 1; }",
]

[[collectors]]
type = "tcp"
key = "tcp.edge"
label = "Edge Relay"
group = "network"
target = "edge.example.com:443"
count = 4

[[collectors]]
type = "tls"
key = "tls.main"
label = "*.example.com TLS"
connect = "127.0.0.1:443"
server_name = "app.example.com"
warn_days = 14
fail_days = 5

# Service uptime monitors (hub-probed public HTTP, or agent-probed internal HTTP/TCP/exec).
[[monitors]]
key = "blog"
name = "Blog"
url = "https://blog.example.com"

[[monitors]]
key = "immich"
name = "Immich"
from = "agent"
url = "http://127.0.0.1:2283/api/server/ping"
expected_body = "pong"

[[monitors]]
key = "postgres"
name = "PostgreSQL"
type = "tcp"
target = "127.0.0.1:5432"

[[monitors]]
key = "caddy"
name = "Caddy"
type = "exec"
command = ["systemctl", "is-active", "--quiet", "caddy"]
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

OpenWrt router / dynamic collectors example with `[[collectors]]` and `collector_dirs`:

```toml
hub_url = "https://status.example.com"
node_id = "router"
label = "OpenWrt"
token = "uptn_node_..."

# Automatically scan this directory on each tick without restarting the agent.
# Supports both:
#   1. Executable scripts (optional `# uptarn.key/label/group/warn_exit_code/format/timeout_ms = ...` headers)
#   2. `.toml` drop-ins (single check or `[[collectors]]` array, full `command = [...]` args, `./` relative paths)
collector_dirs = ["/etc/uptarn/collectors.d"]

[[collectors]]
key = "tailscale"
label = "Tailscale"
group = "network"
command = [
  "sh",
  "-c",
  "tailscale status --peers=false >/dev/null && echo connected",
]

[[collectors]]
key = "wan6"
label = "WAN IPv6"
format = "json"
command = ["/etc/uptarn/check-wan6.sh"]
```

Monitor scheduled jobs either via collector JSON (`jobs[]` emitted from `collector_dirs` — zero wrapper changes) or via Hub Push Ping URLs (`/ping/<token>`):

```sh
# Plain curl (no agent required)
curl -fsS -m 10 https://status.example.com/ping/uptn_job_...

# Or wrap any command to track /start, duration, and /fail stderr tail (no agent.toml needed)
uptarn-agent run --ping-url-file /run/secrets/restic-ping-url -- restic backup /data
```

Or run the agent via Docker (`ghcr.io/so1ve/uptarn-agent`, `linux/amd64` + `linux/arm64`):

```sh
docker run -d --name uptarn-agent --restart unless-stopped --net=host \
  -v /etc/uptarn/agent.toml:/etc/uptarn/agent.toml:ro \
  ghcr.io/so1ve/uptarn-agent:latest
```

## Nix Flake & NixOS Modules

- `packages.<system>.uptarn`: Hub HTTP server and management CLI (`default`)
- `packages.<system>.uptarn-agent`: Linux agent
- `packages.<system>.uptarn-agent-static`: Static `musl` binary for Synology DSM and OpenWrt
- `nixosModules.default`: NixOS modules `services.uptarn` and `services.uptarn-agent`

## Upgrading

- **Cloudflare Workers (Fork + GitHub Actions)**: Click **Sync fork → Update branch** on GitHub. The **Deploy Worker** workflow builds the UI, applies new D1 migrations, and deploys automatically (or run **Deploy Worker** manually with a specific `v*.*.*` tag).
- **Cloudflare Workers (One-click clone)**: Run the **Sync Upstream** workflow in your cloned repository's **Actions** tab (choose `latest-release` or `main`). Pushing to `main` triggers Workers Builds.
- **Cloudflare Workers (Local CLI)**: Run `git pull && pnpm install && pnpm run deploy`. Because instance overrides stay in `wrangler.local.jsonc`, upstream changes to `wrangler.jsonc` apply automatically without conflicts.
- **Docker**: Pull `ghcr.io/so1ve/uptarn:latest` (and `ghcr.io/so1ve/uptarn-agent:latest`) and recreate the container. SQLite migrations run automatically on Hub startup.
- **NixOS**: Run `nix flake update uptarn` and rebuild your hosts.
- **Static Agent binary**: Download the latest `uptarn-agent-{x86_64,aarch64}-unknown-linux-musl` asset and `.sha256` checksum from GitHub Releases, replace the binary, and restart the service.

## Releasing

Bump `package.json`, `Cargo.toml`, and `Cargo.lock` together, commit, and push a `v*.*.*` tag:

```sh
just release
```

## License

[MIT](LICENSE). Made by [Ray](https://github.com/so1ve) with ~~Tokens~~
