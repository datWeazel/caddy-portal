export type Stage = 'production' | 'staging' | 'local';
export const STAGES: readonly Stage[] = ['production', 'staging', 'local'] as const;

export interface Upstream {
  address: string;
  parameters: string | null;
}

export interface DomainOptions {
  /**
   * Default stage to fall back to when the descriptor doesn't carry a per-domain
   * `#stage` suffix. Mirrors `NAConfig.stage` in the original Ruby implementation.
   */
  defaultStage: Stage;
}

/**
 * Same grammar as the original https-portal descriptor:
 *
 *   [ips] user:pass@host:port -> proto://up1|up2[params]  #stage
 *
 * Built without whitespace because JS regex has no /x flag; the Ruby
 * original uses /xi (whitespace + case-insensitive).
 */
const DESCRIPTOR_REGEX = new RegExp(
  [
    '^',
    '(?:\\[(?<ips>[0-9.:\\/, ]*)\\]\\s*)?',
    '(?:(?<user>[^:@\\[\\]]+)(?::(?<pass>[^@]*))?@)?',
    '(?<domain>[a-z0-9._\\-]+?)',
    '(?::(?<port>\\d+))?',
    '(?:',
    '\\s*(?<mode>[-=]>)\\s*',
    '(?<upstreamProto>https?:\\/\\/)?',
    '(?<upstreams>[a-z0-9.:\\/_|\\[= \\]\\-]+?)',
    ')?',
    '(?::?\\s+\\#(?<stage>[a-z]*))?',
    '$',
  ].join(''),
  'i',
);

const UPSTREAM_REGEX = /^(?<address>[^\[]+)(?:\[(?<parameters>.*)\])?$/;

interface ParsedDescriptor {
  ips: string | null;
  user: string | null;
  pass: string | null;
  domain: string;
  port: string | null;
  mode: '->' | '=>' | null;
  upstreamProto: string | null;
  upstreams: string | null;
  stage: string | null;
}

function parseDescriptor(raw: string): ParsedDescriptor | null {
  const stripped = raw.trim();
  const match = DESCRIPTOR_REGEX.exec(stripped);
  if (!match || !match.groups) return null;
  const g = match.groups;
  return {
    ips: g.ips ?? null,
    user: g.user ?? null,
    pass: g.pass ?? null,
    domain: g.domain!,
    port: g.port ?? null,
    mode: (g.mode as '->' | '=>' | undefined) ?? null,
    upstreamProto: g.upstreamProto ?? null,
    upstreams: g.upstreams ?? null,
    stage: g.stage ?? null,
  };
}

export class InvalidDescriptorError extends Error {
  constructor(public readonly descriptor: string) {
    super(`Invalid descriptor: ${descriptor}`);
    this.name = 'InvalidDescriptorError';
  }
}

export class Domain {
  readonly #parsed: ParsedDescriptor;
  readonly #defaultStage: Stage;

  constructor(
    public readonly descriptor: string,
    options: DomainOptions,
  ) {
    const parsed = parseDescriptor(descriptor);
    if (!parsed) throw new InvalidDescriptorError(descriptor);
    this.#parsed = parsed;
    this.#defaultStage = options.defaultStage;
  }

  get name(): string {
    return this.#parsed.domain;
  }

  get port(): string {
    return this.#parsed.port ?? '443';
  }

  /** Uppercase, non-alphanumeric → `_`. Matches Ruby's `name.upcase.tr('^A-Z0-9', '_')`. */
  get envFormatName(): string {
    return this.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  }

  get stage(): Stage | null {
    const raw = this.#parsed.stage ?? '';
    const candidate = raw === '' ? this.#defaultStage : raw;
    return (STAGES as readonly string[]).includes(candidate) ? (candidate as Stage) : null;
  }

  get basicAuthUsername(): string | null {
    return this.#parsed.user;
  }

  get basicAuthPassword(): string | null {
    return this.#parsed.pass;
  }

  get basicAuthEnabled(): boolean {
    return this.basicAuthUsername !== null && this.basicAuthPassword !== null;
  }

  get accessRestriction(): string[] | null {
    if (this.#parsed.ips === null) return null;
    return this.#parsed.ips.split(' ').filter((s) => s.length > 0);
  }

  get upstreams(): Upstream[] {
    const raw = this.#parsed.upstreams ?? '';
    return raw
      .split('|')
      .filter((s) => s.length > 0)
      .map((v) => {
        const m = UPSTREAM_REGEX.exec(v);
        if (!m || !m.groups) throw new Error(`Invalid upstream: ${v}`);
        return {
          address: m.groups.address!,
          parameters: m.groups.parameters ?? null,
        };
      });
  }

  get multipleUpstreams(): boolean {
    return this.upstreams.length > 1;
  }

  get upstreamBackendName(): string {
    return `backend_${this.#parsed.domain}`;
  }

  /** Resolved proto for `->`/`=>` modes; matches Ruby default-proto logic. */
  get upstreamProto(): string | null {
    const mode = this.#parsed.mode;
    if (mode !== '->' && mode !== '=>') return null;
    if (this.#parsed.upstreamProto !== null) return this.#parsed.upstreamProto;
    return mode === '->' ? 'http://' : 'https://';
  }

  /** Full proxy upstream URL for `->` mode. null otherwise (static/redirect). */
  get upstream(): string | null {
    if (this.#parsed.mode !== '->') return null;
    const first = this.upstreams[0];
    if (!first) return null;
    return (this.upstreamProto ?? '') + first.address;
  }

  /** Full redirect target URL for `=>` mode. null otherwise. */
  get redirectTargetUrl(): string | null {
    if (this.#parsed.mode !== '=>') return null;
    const first = this.upstreams[0];
    if (!first) return null;
    if (first.parameters !== null) {
      throw new Error('Parameters not supported on redirect-target');
    }
    return (this.upstreamProto ?? '') + first.address;
  }

  /** Let's Encrypt ACME directory URL for this domain's stage. null for `local`. */
  get ca(): string | null {
    switch (this.stage) {
      case 'production':
        return 'https://acme-v02.api.letsencrypt.org/directory';
      case 'staging':
        return 'https://acme-staging-v02.api.letsencrypt.org/directory';
      case 'local':
        return null;
      default:
        return null;
    }
  }

  get wwwRoot(): string {
    return `/var/www/vhosts/${this.name}`;
  }
}

/**
 * Parse a comma-separated DOMAINS string into Domain objects. Empty entries
 * are skipped, mirroring NAConfig#parse in the original.
 */
export function parseDomains(raw: string, options: DomainOptions): Domain[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((descriptor) => new Domain(descriptor, options));
}
