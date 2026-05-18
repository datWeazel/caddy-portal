import { readFileSync, existsSync } from 'node:fs';
import { Domain, parseDomains, type Stage, STAGES } from './domain.js';

/**
 * Mirrors NAConfig (fs_overlay/opt/certs_manager/lib/na_config.rb).
 *
 * Reads runtime configuration from the process environment plus auto-discovered
 * domains written by docker-gen to /var/run/domains.
 *
 * Designed as a class (with optional env/fs injection) so it stays testable.
 */
export class Config {
  readonly portalBaseDir = '/var/lib/https-portal';
  readonly autoDiscoveredDomainsPath = '/var/run/domains';

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly readFileFn: (path: string) => string = (p) => readFileSync(p, 'utf8'),
    private readonly existsFn: (path: string) => boolean = (p) => existsSync(p),
  ) {}

  get stage(): Stage {
    const raw = this.env.STAGE;
    if (raw && (STAGES as readonly string[]).includes(raw)) return raw as Stage;
    return this.legacyProductionFlag ? 'production' : 'staging';
  }

  private get legacyProductionFlag(): boolean {
    return this.env.PRODUCTION?.toLowerCase() === 'true';
  }

  get forceRenew(): boolean {
    return this.env.FORCE_RENEW?.toLowerCase() === 'true';
  }

  get debugMode(): boolean {
    return Boolean(this.env.DEBUG);
  }

  get renewMarginDays(): number {
    const raw = this.env.RENEW_MARGIN_DAYS;
    if (!raw) return 30;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  }

  /**
   * Key type to pass to Caddy's `tls { key_type ... }`.
   * Accepted vocabulary: rsa2048, rsa4096, p256, p384.
   * Maps from the legacy CERTIFICATE_ALGORITHM=prime256v1 and NUMBITS env vars.
   */
  get keyType(): 'rsa2048' | 'rsa4096' | 'p256' | 'p384' {
    if (this.env.CERTIFICATE_ALGORITHM === 'prime256v1') return 'p256';
    const bits = this.env.NUMBITS;
    if (bits === '4096') return 'rsa4096';
    return 'rsa2048';
  }

  /** HTTP redirect code for `=>` mode. Mirrors the original REDIRECT_CODE env var. */
  get redirectCode(): '301' | '302' | '307' | '308' {
    const raw = this.env.REDIRECT_CODE;
    if (raw === '301' || raw === '302' || raw === '307' || raw === '308') return raw;
    return '307';
  }

  /** HSTS max-age in seconds, or null when HSTS shouldn't be emitted. */
  get hstsMaxAge(): number | null {
    const raw = this.env.HSTS_MAX_AGE;
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  /** Compression: on by default (matching the nginx-era behaviour). */
  get compressionEnabled(): boolean {
    return this.env.GZIP !== 'off';
  }

  /** Index files for static sites. Space-separated, like the original. */
  get indexFiles(): string[] {
    const raw = this.env.INDEX_FILES?.trim();
    if (!raw) return ['index.html'];
    return raw.split(/\s+/).filter((s) => s.length > 0);
  }

  /** Body size limit, e.g. "10MB". null = no limit applied. */
  get clientMaxBodySize(): string | null {
    return this.env.CLIENT_MAX_BODY_SIZE ?? null;
  }

  /** Server-level idle timeout (KEEPALIVE_TIMEOUT). null = use Caddy default. */
  get keepAliveTimeout(): string | null {
    const raw = this.env.KEEPALIVE_TIMEOUT;
    if (!raw) return null;
    // Original was bare seconds (`65`). Caddy needs a Go duration string.
    return /^\d+$/.test(raw) ? `${raw}s` : raw;
  }

  /** Proxy timeouts. null = Caddy defaults. */
  get proxyTimeouts(): { connect: string | null; read: string | null; write: string | null } {
    return {
      connect: durationOrNull(this.env.PROXY_CONNECT_TIMEOUT),
      read: durationOrNull(this.env.PROXY_READ_TIMEOUT),
      write: durationOrNull(this.env.PROXY_SEND_TIMEOUT),
    };
  }

  /** Where access log goes. null = no access log. */
  get accessLog(): LogTarget {
    return parseLogTarget(this.env.ACCESS_LOG, '/var/log/caddy/access.log');
  }

  /** Where error / runtime log goes. Defaults to stderr. */
  get errorLog(): LogTarget {
    return parseLogTarget(this.env.ERROR_LOG, '/var/log/caddy/error.log', 'stderr');
  }

  get errorLogLevel(): string {
    return (this.env.ERROR_LOG_LEVEL ?? 'ERROR').toUpperCase();
  }

  /** Raw Caddyfile fragment to splice into the global `{ ... }` block. */
  get customGlobalBlock(): string | null {
    return this.env.CUSTOM_CADDY_GLOBAL_BLOCK ?? null;
  }

  /** Raw Caddyfile fragment to splice into every site block. */
  get customSiteBlock(): string | null {
    return this.env.CUSTOM_CADDY_SERVER_BLOCK ?? null;
  }

  /**
   * Per-domain override block. Pulled by domain's env_format_name —
   * `example.com` → `CUSTOM_CADDY_EXAMPLE_COM_BLOCK`.
   */
  customSiteBlockFor(envFormatName: string): string | null {
    return this.env[`CUSTOM_CADDY_${envFormatName}_BLOCK`] ?? null;
  }

  get envDomains(): Domain[] {
    if (!this.env.DOMAINS) return [];
    return parseDomains(this.env.DOMAINS, { defaultStage: this.stage });
  }

  get autoDiscoveredDomains(): Domain[] {
    if (!this.existsFn(this.autoDiscoveredDomainsPath)) return [];
    const raw = this.readFileFn(this.autoDiscoveredDomainsPath);
    return parseDomains(raw, { defaultStage: this.stage });
  }

  /** Env-configured + auto-discovered, deduped by `(name, port)` like the original. */
  get domains(): Domain[] {
    const all = [...this.envDomains, ...this.autoDiscoveredDomains];
    return dedupe(all, (d) => `${d.name}|${d.port}`);
  }

  /** Same set but deduped by name only — used for cert issuance (one cert per host). */
  get domainsWithUniqueNames(): Domain[] {
    const all = [...this.envDomains, ...this.autoDiscoveredDomains];
    return dedupe(all, (d) => d.name);
  }
}

export type LogTarget =
  | { kind: 'off' }
  | { kind: 'stdout' }
  | { kind: 'stderr' }
  | { kind: 'file'; path: string };

function parseLogTarget(
  raw: string | undefined,
  defaultFilePath: string,
  defaultKind: 'off' | 'stderr' | 'stdout' = 'off',
): LogTarget {
  if (raw === undefined || raw === '' || raw === 'off') {
    return defaultKind === 'off' ? { kind: 'off' } : { kind: defaultKind };
  }
  if (raw === 'stdout') return { kind: 'stdout' };
  if (raw === 'stderr') return { kind: 'stderr' };
  if (raw === 'default') return { kind: 'file', path: defaultFilePath };
  return { kind: 'file', path: raw };
}

function durationOrNull(raw: string | undefined): string | null {
  if (!raw) return null;
  return /^\d+$/.test(raw) ? `${raw}s` : raw;
}

function dedupe<T>(items: T[], keyFn: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
