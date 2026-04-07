# Night-Orch Deployment Guide

This guide covers deploying night-orch on a Debian server behind Tailscale.

## Prerequisites

- Debian 13+ server accessible only via Tailscale
- Root access for one-time system setup (`useradd`, systemd, packages)
- Node.js 24+ installed (via `mise`, `nvm`, or system package)
- Docker installed (`apt install docker.io docker-cli docker-compose`)
- Caddy installed (`apt install caddy`)

## Initial Setup

### 1. Create Dedicated Runtime User (Required)

Do not run night-orch as `root`. Create and use a dedicated service user:

```bash
useradd --create-home --shell /bin/bash orch
usermod -aG docker orch
sudo -iu orch
```

If you already switched users but `echo $HOME` is not `/home/orch`, re-enter with:

```bash
sudo -iu orch
```

### 2. Install

```bash
npm install -g night-orch
```

Verify: `night-orch --help`

### 3. Install Agent CLIs (as `orch`)

Install both worker CLIs for the non-root user:

```bash
npm install -g @openai/codex @anthropic-ai/claude-code
codex --version
claude --version
```

Authenticate interactively (one time):

```bash
codex login
claude auth
```

If any command still references `/root/...`, your session is not a clean `orch`
login shell. Re-enter with `sudo -iu orch` and retry.

### 4. Configuration

Run the interactive setup wizard:

```bash
night-orch init
```

Or configure manually:

```bash
mkdir -p ~/.night-orch
night-orch init  # copies example config and walks through setup
# Or manually create ~/.night-orch/config.yaml
```

Create the environment file with secrets:

```bash
cat > ~/.night-orch/.env << 'EOF'
GITHUB_TOKEN=ghp_...
GRAFANA_ADMIN_PASSWORD=changeme
EOF
chmod 0600 ~/.night-orch/.env
```

### 5. Monitoring Stack (Prometheus + Grafana)

Night-orch bundles Prometheus and Grafana configs. Extract them:

```bash
night-orch monitoring init
```

This creates `~/.config/night-orch/monitoring/` with a Docker Compose file,
Prometheus scrape config, and Grafana dashboards.

For production, edit the compose file to bind ports to localhost only:

```yaml
services:
  prometheus:
    ports:
      - "127.0.0.1:9091:9090"  # not "9091:9090"
  grafana:
    ports:
      - "127.0.0.1:3001:3000"
```

If using `network_mode: host` for Prometheus (to scrape host-local metrics without
firewall issues), set `--web.listen-address=127.0.0.1:9091` in the command.

Start the monitoring stack:

```bash
night-orch monitoring up
```

### 6. AppArmor Fix for Docker

On Debian 13, the runc AppArmor profile breaks Docker containers:

```bash
aa-disable runc
```

This must be re-applied after `aa-enforce /etc/apparmor.d/*` or reboots that
re-enforce profiles.

## Running

### Supervisor Mode (Recommended)

The `night-orch serve` command runs a supervisor that manages both the poller
and web server as child processes, with self-update support:

```bash
night-orch serve --allowed-host night-orch.hllg.eu
```

This spawns:
- `night-orch run` — headless poller + MCP + metrics
- `night-orch web` — web UI (attach mode)

The supervisor handles:
- Auto-respawn on child crash (with exponential backoff)
- Graceful drain and restart on self-update
- Rollback if an update fails or if post-update health checks fail

### Systemd Unit

Create `/etc/systemd/system/night-orch.service`:

```ini
[Unit]
Description=Night-Orch Supervisor
After=network-online.target wait-for-tailscale.service docker.service
Wants=network-online.target
Requires=wait-for-tailscale.service

[Service]
Type=simple
User=orch
Group=orch
WorkingDirectory=/home/orch
Environment=HOME=/home/orch
Environment=XDG_CONFIG_HOME=/home/orch/.config
Environment=XDG_DATA_HOME=/home/orch/.local/share
Environment=XDG_CACHE_HOME=/home/orch/.cache
Environment=XDG_STATE_HOME=/home/orch/.local/state
Environment=PATH=/home/orch/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStartPre=/home/orch/.local/bin/night-orch monitoring up
ExecStart=/home/orch/.local/bin/night-orch serve --allowed-host night-orch.hllg.eu --config /home/orch/.night-orch/config.yaml
EnvironmentFile=-/home/orch/.night-orch/.env
Restart=on-failure
RestartSec=5
MemoryMax=6G
CPUQuota=300%

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now night-orch
```

### Ports (all localhost except Caddy)

| Port | Service | Binding |
|------|---------|---------|
| 3200 | night-orch web UI | 127.0.0.1 |
| 3100 | MCP HTTP/SSE | 127.0.0.1 |
| 9090 | night-orch metrics | 0.0.0.0 (for Prometheus) |
| 9091 | Prometheus | 127.0.0.1 |
| 3001 | Grafana | 127.0.0.1 |
| 443  | Caddy (HTTPS) | Tailscale IP |

## Reverse Proxy (Caddy)

Caddy terminates TLS and provides basic auth. Configure `/etc/caddy/Caddyfile`:

```
{
    auto_https off
}

night-orch.example.com {
    bind <TAILSCALE_IP>
    tls /etc/caddy/certs/cert.crt /etc/caddy/certs/cert.key
    reverse_proxy 127.0.0.1:3200
    basicauth {
        admin <BCRYPT_HASH>
    }
}

monitoring.example.com {
    bind <TAILSCALE_IP>
    tls /etc/caddy/certs/cert.crt /etc/caddy/certs/cert.key
    reverse_proxy 127.0.0.1:3001
    basicauth {
        admin <BCRYPT_HASH>
    }
}
```

Generate the password hash: `caddy hash-password`

### TLS Certificates

Since the server has no public IP (Tailscale only), standard ACME won't work.
Options:
- **Own CA**: Issue certs from your own CA, place at `/etc/caddy/certs/`
- **DNS-01 ACME**: Build Caddy with a DNS plugin (e.g., cloudflare), use a
  scoped API token for automatic Let's Encrypt certs
- **Tailscale HTTPS**: Use `tailscale cert` for `*.ts.net` domains

### Caddy Systemd Drop-in

Caddy must wait for Tailscale since it binds to the Tailscale IP:

```bash
mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/tailscale.conf << 'EOF'
[Unit]
After=wait-for-tailscale.service
Requires=wait-for-tailscale.service

[Service]
MemoryMax=512M
CPUQuota=50%
EOF
systemctl daemon-reload
```

## Self-Update

Night-orch supports one-button self-update that installs the latest version
and restarts all services without downtime.

### From the Web UI

Click the **Pull & Restart** button in the Deploy section of the Operations panel.
The button shows the current update state (draining, pulling, building, restarting, health-checking).

### From the CLI

```bash
night-orch update
```

If running under the supervisor, this sends an IPC message. Otherwise, it creates
a trigger file that the supervisor picks up.

### From MCP (Claude Code)

Use the `night-orch-update` tool.

### Update Flow

The update mechanism auto-detects how night-orch was installed:

**npm global install** (default):
1. Supervisor receives update trigger
2. Sends SIGTERM to both children (waits up to 5 min for active runs to finish)
3. Checks npm registry for latest version
4. `npm install -g night-orch@latest`
5. Respawns both children with new code
6. Runs health checks (see below)
7. On failure: rolls back via `npm install -g night-orch@<previous-version>`

**Git checkout** (development):
1. Supervisor receives update trigger
2. Sends SIGTERM to both children
3. `git pull --ff-only`
4. `pnpm install && pnpm build && pnpm install-global`
5. Respawns both children with new code
6. Runs health checks (see below)
7. On failure: rolls back to previous commit, rebuilds, respawns

**Health checks** (both modes):
- run server (`/health` on MCP HTTP endpoint when MCP is enabled, otherwise process liveness stabilization)
- web API (`/api/health`)
- web frontend (`/`)

### Update Status

Status is tracked at `~/.config/night-orch/update-status.json` and available
via `GET /api/update-status`. States: `idle`, `draining`, `pulling`, `building`,
`restarting`, `health-checking`, `rolling-back`, `failed`.

## Troubleshooting

### Port already in use

If switching from separate `night-orch-server` + `night-orch-web` services to
the supervisor, stop the old units first:

```bash
systemctl stop night-orch-server night-orch-web
systemctl disable night-orch-server night-orch-web
```

### Docker containers won't start

Check if the runc AppArmor profile is enforced:

```bash
aa-status | grep runc
# If it shows "enforce", disable it:
aa-disable runc
systemctl restart docker
```

### Web UI shows "Forbidden host"

Add `--allowed-host <your-domain>` to the `night-orch serve` command.
The web server validates the `Host` header against allowed hostnames.

### Grafana shows "no data"

Verify Prometheus can scrape the metrics endpoint:

```bash
curl http://127.0.0.1:9091/api/v1/targets
```

If the target is down, check that the scrape target port in `prometheus.yml`
matches the night-orch metrics port (default: 9090).
Also ensure `metrics.host` in your night-orch config is reachable from Docker
(`0.0.0.0` for the default monitoring stack).
