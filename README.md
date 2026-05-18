# caddy-portal

Automatic HTTPS for any web application, configured by a single environment
variable. Spiritual successor to [https-portal](https://github.com/SteveLTN/https-portal),
rebuilt on [Caddy](https://caddyserver.com) instead of Nginx.

> **Status: pre-release.** Not yet published. APIs subject to change until v1.0.

## Why

- **HTTP/3 (QUIC)** out of the box
- **Smaller image** — single static Caddy binary, no acme-tiny, no cron, no dhparam dance
- **Structured JSON logs** ready for log aggregators
- **DNS-01 challenges** path open (Phase 2) — wildcard certs, port 80 not required
- **Drop-in for the majority** — same `DOMAINS` descriptor syntax, same persistent
  volume path, same `VIRTUAL_HOST` auto-discovery

## Quick start

```yaml
services:
  caddy-portal:
    image: datweazel/caddy-portal:1
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"      # HTTP/3
    environment:
      DOMAINS: "example.com -> http://app:80"
      # STAGE: production  # default is staging until you confirm DNS works
    volumes:
      - caddy-portal-data:/var/lib/https-portal

  app:
    image: your/app

volumes:
  caddy-portal-data:
```

## Coming from `steveltn/https-portal`

Most setups work unchanged after switching the image and setting
`MIGRATE_FROM_NGINX=true` once (imports existing certificates).

See [docs/migration.md](docs/migration.md) for what does and doesn't carry
over. Short version: anything `CUSTOM_NGINX_*` or any Nginx-template
bind-mount is **not supported**.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for attribution.
