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
