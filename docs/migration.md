# Migrating from `steveltn/https-portal`

This guide covers switching an existing `steveltn/https-portal` deployment to
`datweazel/caddy-portal`. For most setups it's a three-line change to your
`docker-compose.yml` plus a one-shot env flag to import existing certificates.

If you rely on `CUSTOM_NGINX_*` config blocks, bind-mounted Nginx templates,
or upstream parameters like `weight=` / `backup`, caddy-portal will warn or
flat-out skip them. Those use cases are documented under
[Not supported](#not-supported).

## TL;DR

```yaml
services:
  https-portal:
    image: datweazel/caddy-portal:1     # was: steveltn/https-portal:1
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"                   # NEW: enables HTTP/3
    environment:
      DOMAINS: "example.com -> http://app:80"
      STAGE: production
      MIGRATE_FROM_NGINX: "true"        # one-shot import, remove after first start
    volumes:
      - https-portal-data:/var/lib/https-portal   # path unchanged
```

Bring it up, watch the logs for `Imported cert for example.com (production)`,
verify the site, then remove `MIGRATE_FROM_NGINX` from the env. Done.

If something looks off, your old certs are untouched in
`/var/lib/https-portal/<domain>/<stage>/` — see
[Rollback](#rollback).

## What carries over

The public surface that's preserved:

- The `DOMAINS` env var with the **exact same descriptor grammar**:
  - `host`, `host:port`, `host -> upstream`, `host => redirect-target`
  - `user:pass@host` for HTTP Basic Auth
  - `[1.2.3.4/24] host` for IP allow-lists
  - `host -> a|b|c` for multiple upstreams
  - `host -> https://upstream` for upstream protocol override
  - trailing `#stage` for per-domain stage overrides
- The `STAGE` values `production` / `staging` / `local`
- `FORCE_RENEW`, `RENEW_MARGIN_DAYS`, `REDIRECT_CODE`
- The persistent volume path `/var/lib/https-portal`
- Auto-discovery via `VIRTUAL_HOST` env on neighbouring containers
  (docker-gen is still in the image)
- `HSTS_MAX_AGE`, `CLIENT_MAX_BODY_SIZE`, `KEEPALIVE_TIMEOUT`,
  `PROXY_CONNECT_TIMEOUT` / `PROXY_READ_TIMEOUT` / `PROXY_SEND_TIMEOUT`,
  `ACCESS_LOG` / `ERROR_LOG` / `ERROR_LOG_LEVEL`, `INDEX_FILES`, `GZIP`
- `NUMBITS` and `CERTIFICATE_ALGORITHM=prime256v1` (mapped to Caddy's `key_type`)

If your old `docker-compose.yml` only used these settings, the migration is
literally swapping the image name.

## Not supported

Hard breaks. If your setup depends on these, caddy-portal isn't the right
target — stay on `steveltn/https-portal`.

| Setting | What happens with caddy-portal |
|---|---|
| `CUSTOM_NGINX_GLOBAL_HTTP_CONFIG_BLOCK` | Warning at startup, ignored |
| `CUSTOM_NGINX_SERVER_CONFIG_BLOCK` | Warning at startup, ignored |
| `CUSTOM_NGINX_SERVER_PLAIN_CONFIG_BLOCK` | Warning at startup, ignored |
| `CUSTOM_NGINX_<DOMAIN>_CONFIG_BLOCK` | Warning at startup, ignored |
| `ACME_CHALLENGE_BLOCK` | Warning, ignored (Caddy handles ACME natively) |
| `DEFAULT_SERVER_BLOCK` | Warning, ignored (Caddy refuses unknown SNI) |
| Bind-mount of `/var/lib/nginx-conf/*.erb` | Files exist nowhere in the image; mount has no effect |
| Bind-mount of `/etc/nginx/nginx.conf` | Same |
| Upstream parameters `weight=N`, `backup`, `max_conns=N` | Parsed, address kept, parameters dropped with a warning |

For users on the first four rows, the replacement story is
[Custom Caddy snippets](../README.md#custom-caddy-snippets) in the README —
but it's a manual rewrite from Nginx-syntax to Caddyfile-syntax, not a
mechanical translation.

## Silent no-ops

These env vars are recognised but irrelevant in Caddy world. caddy-portal
prints one info-level line per detection so you know they can be removed:

- `WORKER_PROCESSES`, `WORKER_CONNECTIONS` — Caddy is goroutine-based, no per-worker tuning
- `PROXY_BUFFERS`, `PROXY_BUFFER_SIZE` — Caddy buffers internally with no exposed knobs
- `SERVER_NAMES_HASH_MAX_SIZE`, `SERVER_NAMES_HASH_BUCKET_SIZE` — concept doesn't exist in Caddy
- `SERVER_TOKENS` — Caddy hides its version by default
- `WEBSOCKET` — Caddy's `reverse_proxy` upgrades websockets automatically; no toggle needed
- `LISTEN_IPV6` — Caddy binds IPv4 + IPv6 by default
- `DYNAMIC_UPSTREAM` — different mechanism in Caddy; if you need it, see Caddy's `dynamic_upstreams`
- `RESOLVER` — Caddy uses the Go DNS resolver; configure DNS at the host or container level
- `ACCESS_LOG_INCLUDE_HOST` — host is always present in Caddy's JSON access log
- `ACCESS_LOG_BUFFER` — Caddy file output buffering is configured differently and rarely needed

## Migration procedure

### 1. Verify your current setup is healthy

Make sure your existing site is serving HTTPS correctly and your cert is
valid. The migration imports whatever is on disk — if your existing certs
are already broken, the new container inherits that.

```sh
curl -I https://your-domain.example/
```

You want a `200` (or whatever your app returns) with a valid TLS cert,
not a `502` or a cert error.

### 2. Update `docker-compose.yml`

Change the image:

```diff
 services:
   https-portal:
-    image: steveltn/https-portal:1
+    image: datweazel/caddy-portal:1
```

Add UDP/443 for HTTP/3 (optional but recommended):

```diff
     ports:
       - "80:80"
       - "443:443"
+      - "443:443/udp"
```

Add the one-shot migration flag:

```diff
     environment:
       DOMAINS: "example.com -> http://app:80"
       STAGE: production
+      MIGRATE_FROM_NGINX: "true"
```

Leave the volume mount exactly as it was — `/var/lib/https-portal` is the
same path in both images, and the import step reads from there.

### 3. Bring it up

```sh
docker compose down
docker compose pull
docker compose up -d
docker compose logs -f https-portal
```

Watch for these log lines:

```
[caddy-portal] Imported cert for example.com (production) from /var/lib/https-portal/example.com/production/chained.crt
[caddy-portal] Migration complete: 1 imported, 0 skipped.
[caddy-portal] rendered Caddyfile: 1 domain(s), stage=production
```

Then Caddy itself starts up and you'll see structured JSON logs from it.

### 4. Verify

```sh
# HTTPS still works and cert is valid:
curl -I https://your-domain.example/

# Cert was imported, not freshly issued (compare "notAfter" with old cert):
echo | openssl s_client -connect your-domain.example:443 -servername your-domain.example 2>/dev/null \
  | openssl x509 -noout -dates
```

Check the browser, your monitoring, your application — the usual.

### 5. Remove the migration flag

After the first successful start, a marker file at
`/var/lib/https-portal/.migrated-from-nginx` prevents the import from
re-running. The env var is now a no-op, but it's cleaner to remove it:

```diff
     environment:
       DOMAINS: "example.com -> http://app:80"
       STAGE: production
-      MIGRATE_FROM_NGINX: "true"
```

A `docker compose up -d` picks up the env change without a rebuild.

## Where do the imported certs end up?

Original layout (untouched after migration):

```
/var/lib/https-portal/example.com/production/
├── signed.crt        ← imported as-is if chained.crt is missing
├── chained.crt       ← preferred source (full chain)
├── domain.key
├── domain.csr
└── ...
```

Caddy storage layout (written during migration):

```
/var/lib/https-portal/caddy/certificates/acme-v02.api.letsencrypt.org-directory/example.com/
├── example.com.crt
├── example.com.key
└── example.com.json
```

For staging certs, the issuer key is `acme-staging-v02.api.letsencrypt.org-directory`.
Local-stage certs are not migrated — Caddy reissues them via its internal CA
on first request.

Caddy treats the imported certs as its own and renews them via ACME when they
approach expiry (default: when ~1/3 of lifetime remains).

## Rollback

Migration is non-destructive: it **copies** certs into Caddy's storage layout,
it doesn't move or delete the originals. If you need to roll back:

1. `docker compose down`
2. Swap the image back: `datweazel/caddy-portal:1` → `steveltn/https-portal:1`
3. Remove `MIGRATE_FROM_NGINX` and the UDP port mapping if you added it
4. `docker compose up -d`

The original cert files are still where https-portal expects them. The
`caddy/` subdirectory inside the volume is dead weight at that point — safe
to delete, but harmless to leave.

If you need a truly clean reset on the caddy-portal side (for example to
re-run migration after fixing source certs), delete both:

```sh
docker compose down
docker run --rm -v https-portal-data:/data alpine \
  sh -c 'rm -rf /data/caddy /data/.migrated-from-nginx'
docker compose up -d
```

## Troubleshooting

### "Migration marker present, skipping legacy cert import"

You already migrated this volume once. To run it again (rarely useful — but
sometimes you want to re-import after manually fixing source certs):

```sh
docker compose exec https-portal rm /var/lib/https-portal/.migrated-from-nginx
docker compose restart https-portal
```

### Caddy reissues the cert instead of using the imported one

This can happen if the imported metadata JSON is rejected by Caddy's internal
schema check (unlikely, but possible if Caddy's certmagic format changes).
The reissue uses the configured `STAGE` — production hits real Let's Encrypt
rate limits, so test with `STAGE=staging` first when in doubt.

Symptoms: Caddy logs show `obtaining certificate` for an already-migrated
domain. The migration log earlier reported `Imported cert for ...`.

Fixes:
- If you have headroom on Let's Encrypt rate limits, just let it reissue
- If not: stop the container, restore the original `steveltn/https-portal`
  setup, and open an issue with the Caddy version and your cert metadata file

### "no Docker socket mounted; auto-discovery disabled"

You're using `VIRTUAL_HOST` env vars on neighbour containers but caddy-portal
isn't picking them up. Mount the Docker socket:

```yaml
    volumes:
      - https-portal-data:/var/lib/https-portal
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

Read-only is fine and recommended.

### Welcome page shows but my reverse proxy is broken

The welcome page is only served for domains with neither an upstream
(`->`) nor a redirect target (`=>`) in the descriptor. If you see it
when you expected proxying, your DOMAINS string is missing the `-> url`
part. Compare against the [DOMAINS reference](../README.md#domains-descriptor-reference).

### `CUSTOM_NGINX_*` warning in logs

Expected. caddy-portal can't translate Nginx config snippets to Caddy syntax.
Either remove the env var (if you don't actually need that customization
anymore) or rewrite it as a `CUSTOM_CADDY_*` block. See the
[Custom Caddy snippets](../README.md#custom-caddy-snippets) section of the
README for the equivalent.

## Got stuck?

File an issue at
[github.com/datWeazel/caddy-portal/issues](https://github.com/datWeazel/caddy-portal/issues)
with:

- Your old `docker-compose.yml` (redact secrets)
- The migration log lines (the `[caddy-portal]` ones and a few Caddy lines after)
- What you expected vs. what you got
