# caddy-portal

Automatic HTTPS for any web application, configured by a single environment
variable. Spiritual successor to [https-portal](https://github.com/SteveLTN/https-portal),
rebuilt on [Caddy](https://caddyserver.com) instead of Nginx.

> **Status: pre-release.** Not yet on Docker Hub. The descriptor grammar and
> documented env vars are stable; internal behaviour may shift until v1.0.

> [!CAUTION]
> **Vibecode Disclaimer**  
> I built the first version of this rewrite with the help of Claude Code (Claude Opus 4.7). I still made sure I understand the code and its behavior so this isn't a copy-paste AI slop rewrite.

## Why

- **HTTP/3 (QUIC)** out of the box — no flags, no rebuild
- **Smaller image** (~140 MB vs. ~200 MB) — single static Caddy binary, no acme-tiny, no cron, no DH-param generation
- **Caddy renews certs in-process** — no cron job to monitor, renewal failures land in the same log stream
- **Modern TLS defaults** that keep up with best practice automatically — no cipher lists to maintain
- **Structured JSON logs** ready for Loki / Elastic / Datadog
- **Drop-in for the majority** — same `DOMAINS` descriptor syntax, same persistent volume path, same `VIRTUAL_HOST` auto-discovery
- **Atomic config reloads** via Caddy's admin API — no "reload failed silently" drift
- **No restart cascades** — backend containers can restart freely (Caddy re-resolves DNS per request), and new domains can be hot-added via `dynamic-env` or `VIRTUAL_HOST` without touching caddy-portal itself. See [Changing configuration at runtime](#changing-configuration-at-runtime)

What's deliberately *not* preserved: `CUSTOM_NGINX_*` env vars,
bind-mounts of Nginx templates, and a handful of Nginx-specific tuning knobs.
See [docs/migration.md](docs/migration.md) for the full list.

## Quick start

```yaml
services:
  caddy-portal:
    image: datweazel/caddy-portal:1
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"        # HTTP/3
    environment:
      DOMAINS: "example.com -> http://app:80"
      STAGE: staging         # use 'production' once DNS + reachability are confirmed
    volumes:
      - caddy-portal-data:/var/lib/https-portal

  app:
    image: your/app

volumes:
  caddy-portal-data:
```

Bring it up with `docker compose up -d`. Caddy obtains a certificate from
Let's Encrypt's staging environment, then any request to
`https://example.com` is reverse-proxied to your `app` container.

Once you've verified everything works, swap `STAGE: staging` →
`STAGE: production` to get real (browser-trusted) certificates.

## `DOMAINS` descriptor reference

`DOMAINS` is a comma-separated list of descriptors. Each descriptor follows:

```
[ips] user:pass@host:port -> protocol://upstream(s) #stage
```

Everything except `host` is optional. Examples:

| Descriptor | What it does |
|---|---|
| `example.com` | Static site, serves a welcome page until you mount your own content under `/var/www/vhosts/example.com` |
| `example.com -> http://app:80` | Reverse-proxy to `app:80` over plain HTTP |
| `example.com -> https://backend:8443` | Reverse-proxy to an HTTPS backend |
| `example.com:8443 -> http://app` | Listen on `:8443` instead of `:443` |
| `example.com => https://www.example.com` | 307 redirect (use `REDIRECT_CODE=301` for permanent) |
| `www.example.com => https://example.com, example.com -> http://app` | The classic `www → apex` setup |
| `user:s3cret@example.com -> http://app` | HTTP Basic Auth in front of the proxy |
| `[10.0.0.0/8] example.com -> http://app` | Allow only the listed IPs; everyone else gets `403` |
| `example.com -> http://a:80\|b:80` | Round-robin load balance across two upstreams |
| `dev.example.com -> http://app #local` | Override the global stage for this one domain (here: self-signed via Caddy's internal CA) |

Multi-line YAML works too:

```yaml
DOMAINS: >
  example.com -> http://app:80,
  api.example.com -> http://api:3000,
  admin.example.com -> http://admin:4000 #staging
```

## Configuration

The minimum you need is `DOMAINS`. Everything else has sensible defaults.

### Stages

| `STAGE` | What it does | When to use |
|---|---|---|
| `production` | Real Let's Encrypt certificates, trusted by browsers | After you've verified DNS + reachability with `staging` |
| `staging` (default) | Let's Encrypt staging certs — **not browser-trusted**. No rate-limit risk | Initial testing |
| `local` | Self-signed certs via Caddy's internal CA | Local dev where you don't have real DNS |

A trailing `#stage` on a descriptor overrides the global stage for one
domain only: `example.com -> http://app #staging` always uses staging
even when `STAGE=production`.

### Environment variables

The full list. Anything not listed here is either an https-portal Nginx-ism
that's intentionally dropped (see [docs/migration.md](docs/migration.md))
or unsupported.

#### Core

| Variable | Default | Meaning |
|---|---|---|
| `DOMAINS` | _(none)_ | Comma-separated descriptors; see above |
| `STAGE` | `staging` | `production` \| `staging` \| `local` |
| `FORCE_RENEW` | `false` | `true` forces all certs to renew on next start |
| `RENEW_MARGIN_DAYS` | `30` | Renew this many days before expiry (Caddy renews around 1/3 lifetime by default; this is best-effort mapped) |
| `MIGRATE_FROM_NGINX` | `false` | One-shot import of certs from a `steveltn/https-portal` volume layout |

#### Certificate algorithm

| Variable | Default | Meaning |
|---|---|---|
| `NUMBITS` | `2048` | RSA key size; `4096` for stronger keys |
| `CERTIFICATE_ALGORITHM` | `rsa` | Set to `prime256v1` to use ECDSA P-256 keys |

#### Routing

| Variable | Default | Meaning |
|---|---|---|
| `REDIRECT_CODE` | `307` | Code used by `=>` redirects; valid: `301`, `302`, `307`, `308` |
| `INDEX_FILES` | `index.html` | Space-separated list of index files for static sites |
| `HSTS_MAX_AGE` | _(unset)_ | Emit `Strict-Transport-Security: max-age=<N>` |
| `CLIENT_MAX_BODY_SIZE` | _(unlimited)_ | e.g. `20MB` |
| `GZIP` | `on` | Set to `off` to disable response compression (Caddy emits zstd + gzip when enabled) |

#### Proxy & timeouts

| Variable | Default | Meaning |
|---|---|---|
| `KEEPALIVE_TIMEOUT` | _(Caddy default)_ | Server-side idle timeout |
| `PROXY_CONNECT_TIMEOUT` | _(Caddy default)_ | Backend dial timeout |
| `PROXY_SEND_TIMEOUT` | _(Caddy default)_ | Backend write timeout |
| `PROXY_READ_TIMEOUT` | _(Caddy default)_ | Backend read timeout |

Bare numbers are treated as seconds; Go duration strings (`30s`, `2m`) work too.

#### Logging

| Variable | Default | Meaning |
|---|---|---|
| `ACCESS_LOG` | `off` | `off` \| `stdout` \| `stderr` \| `default` (= `/var/log/caddy/access.log`) \| _custom path_ |
| `ERROR_LOG` | `stderr` | Same vocabulary as `ACCESS_LOG`, default path `/var/log/caddy/error.log` |
| `ERROR_LOG_LEVEL` | `ERROR` | Caddy log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |

Logs come out as JSON. Pipe them straight into your log aggregator.

#### Custom Caddy snippets

For anything caddy-portal doesn't natively expose, three escape hatches:

| Variable | Spliced into |
|---|---|
| `CUSTOM_CADDY_GLOBAL_BLOCK` | The global `{ ... }` options block |
| `CUSTOM_CADDY_SERVER_BLOCK` | Every site block |
| `CUSTOM_CADDY_<HOST>_BLOCK` | Only the matching site (`example.com` → `CUSTOM_CADDY_EXAMPLE_COM_BLOCK`) |

The content is raw Caddyfile syntax — see
[caddyserver.com/docs/caddyfile](https://caddyserver.com/docs/caddyfile).

Example: add a security headers preset to every site:

```yaml
environment:
  CUSTOM_CADDY_SERVER_BLOCK: |
    header {
      Referrer-Policy "strict-origin-when-cross-origin"
      Permissions-Policy "geolocation=(), microphone=()"
      X-Content-Type-Options "nosniff"
    }
```

## Auto-discovery

Mount the Docker socket and any container with a `VIRTUAL_HOST` env var gets
auto-routed:

```yaml
services:
  caddy-portal:
    image: datweazel/caddy-portal:1
    ports: ["80:80", "443:443", "443:443/udp"]
    environment:
      STAGE: production
    volumes:
      - caddy-portal-data:/var/lib/https-portal
      - /var/run/docker.sock:/var/run/docker.sock:ro    # ← discovery hook

  wordpress:
    image: wordpress
    environment:
      VIRTUAL_HOST: "blog.example.com"
      VIRTUAL_PORT: "80"
```

caddy-portal watches Docker events. When the `wordpress` container starts,
a domain descriptor is written, the Caddyfile is re-rendered, and Caddy
reloads atomically. Stop the container and the route is removed on the next
reload.

`VIRTUAL_HOST` accepts the full descriptor syntax — including IP allow-lists
and basic auth: `VIRTUAL_HOST: "[10.0.0.0/8] admin@s3cret:blog.example.com"`.

## Changing configuration at runtime

Two situations where caddy-portal doesn't need a restart.

### Backend container restarts (new Docker IP)

Caddy resolves upstream hostnames at **request time**, not at config load.
When a container behind `reverse_proxy app:80` is stopped and a new instance
takes its place — even with a different Docker network IP — the next request
re-resolves `app` against Docker's embedded DNS and connects to the new IP.

This works out of the box, no `DYNAMIC_UPSTREAM` or `RESOLVER` configuration
required. The legacy nginx setup needed careful tuning here and silently
broke when misconfigured; that whole class of bug is gone.

Verified end-to-end: stop a backend container, claim its IP with a temporary
container so the backend gets reassigned a different IP on next start —
existing connections fail over to the new IP without caddy-portal
intervention.

### Adding, removing, or changing domains

Two patterns, depending on whether the new backend is a Docker container
under your control.

**Pattern A — `VIRTUAL_HOST` on the new container** (preferred when applicable):

Mount the Docker socket once (see [Auto-discovery](#auto-discovery)), then
any neighbour container with a `VIRTUAL_HOST` env var is picked up
automatically:

```yaml
services:
  new-app:
    image: your/new-app
    environment:
      VIRTUAL_HOST: "new.example.com -> http://new-app:80"
```

`docker compose up -d new-app` → docker-gen sees the new container →
caddy-portal re-renders the Caddyfile → Caddy reloads atomically. The new
site is live in about one second.

Stop the container and the route is removed on the next reload, same loop.

**Pattern B — write the new `DOMAINS` to `dynamic-env`**:

Use this when the new backend isn't a Docker container, or when you want to
change other settings (redirects, IP allow-lists, basic auth) without
touching neighbouring containers. Bind-mount the dynamic-env directory:

```yaml
services:
  caddy-portal:
    # ...
    volumes:
      - caddy-portal-data:/var/lib/https-portal
      - ./caddy-portal-env:/var/lib/https-portal/dynamic-env
```

Then on the host, write the **complete** new DOMAINS list to a file named
`DOMAINS`:

```sh
echo "example.com -> http://app:80, new.example.com -> http://newapp:80" \
  > ./caddy-portal-env/DOMAINS
```

caddy-portal sees the file change (debounced ~1s via `fs.watch`), re-reads
the merged environment, re-renders the Caddyfile, and runs `caddy reload`.
The new site is live without dropping existing connections.

> **Important:** a file in `dynamic-env/` *replaces* the corresponding env
> var, it doesn't append. To add a domain you must write the full list
> including any pre-existing ones. Same semantics apply to every other env
> var overlaid this way.

### Live-tuning any other env var

The same mechanism works for every documented env var. Drop a file named
after the variable, its contents become the new value, caddy-portal reloads
within a second:

```sh
echo "120"     > ./caddy-portal-env/KEEPALIVE_TIMEOUT
echo "50MB"    > ./caddy-portal-env/CLIENT_MAX_BODY_SIZE
echo "stdout"  > ./caddy-portal-env/ACCESS_LOG
echo "31536000" > ./caddy-portal-env/HSTS_MAX_AGE
```

Filenames must be UPPERCASE env-var-style identifiers (matching
`^[A-Z][A-Z0-9_]*$`). Lowercase or non-conforming filenames are ignored —
useful if you want to leave a `README.txt` in the directory.

Settings that affect cert issuance (`STAGE`, `CERTIFICATE_ALGORITHM`,
`NUMBITS`) can also be changed live, but renewal happens lazily — Caddy
won't rotate existing certs until they near expiry unless you also set
`FORCE_RENEW=true` in the same dynamic-env change.

## Volume layout

Everything that needs to survive container restarts lives under
`/var/lib/https-portal`:

```
/var/lib/https-portal/
├── caddy/                          ← Caddy's own data dir
│   ├── certificates/<acme-ca>/<domain>/   issued certs + metadata
│   ├── locks/                              locking primitives during renewal
│   └── ocsp/                               cached OCSP staples
├── dynamic-env/                    ← write env-var overrides here for live reload
│   └── <ENV_VAR_NAME>              file contents become the env value
├── .migrated-from-nginx            ← migration marker
└── <domain>/<stage>/...            ← legacy https-portal layout, only present after migration
```

For details on writing into `dynamic-env/` to drive live reloads, see
[Changing configuration at runtime](#changing-configuration-at-runtime).

## Coming from `steveltn/https-portal`

See [docs/migration.md](docs/migration.md) for the full guide. Short
version:

1. Change the image to `datweazel/caddy-portal:1`
2. Add `MIGRATE_FROM_NGINX: "true"` to the env (one-shot)
3. Add `"443:443/udp"` to ports (optional, enables HTTP/3)
4. `docker compose up -d`
5. Remove the migration flag after the first successful start

If you rely on `CUSTOM_NGINX_*` or bind-mounted `.conf.erb` files,
caddy-portal is not for you — stay on `steveltn/https-portal`.

## Troubleshooting

### My site returns a 502

The reverse-proxy backend is unreachable. Check that the upstream container
name resolves inside the Docker network (`docker compose exec caddy-portal
wget -O- http://your-backend:80`) and that the backend is actually listening.

### Cert obtained from Let's Encrypt staging but browser doesn't trust it

Expected on `STAGE: staging`. The staging environment exists exactly to
test without hitting production rate limits. Switch to `STAGE: production`
once the staging cert works.

### "no Docker socket mounted; auto-discovery disabled"

You're using `VIRTUAL_HOST` but didn't mount the socket. Add:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

### HTTP/3 doesn't seem to be used

Browsers only switch to HTTP/3 after the server advertises it (via the
`alt-svc` header on the first HTTP/2 response) and the client decides to
upgrade. Confirm:

```sh
curl -sI https://your-domain.example/ | grep -i alt-svc
# alt-svc: h3=":443"; ma=2592000
```

If `alt-svc` is missing, you probably didn't expose `443:443/udp` — Caddy
emits the header only when the UDP listener is actually bound.

### `[caddy-portal] CUSTOM_NGINX_* will be ignored`

Expected. See [docs/migration.md#not-supported](docs/migration.md#not-supported)
for the migration story.

### Reload didn't pick up my change

`caddy-portal` watches `/var/run/domains` and `/var/lib/https-portal/dynamic-env`
with a 1-second debounce. If you're editing env vars on the host's compose
file, those don't propagate into the container at runtime — for that, see
[Changing configuration at runtime](#changing-configuration-at-runtime)
or restart the container.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This project preserves the public configuration surface of
[steveltn/https-portal](https://github.com/SteveLTN/https-portal) but is
implemented from scratch in TypeScript on top of
[Caddy](https://caddyserver.com).
