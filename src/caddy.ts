import bcrypt from 'bcryptjs';
import type { Domain, Stage } from './domain.js';
import type { Config, LogTarget } from './config.js';

/**
 * Render a complete Caddyfile from the runtime config.
 *
 * Layout:
 *   - One global options block: storage, admin, default ACME CA (if not local)
 *   - One site block per domain (no port collapsing — Caddy handles bundling)
 *
 * Supported descriptor features:
 *   - Proxy mode (`-> upstream(s)`) — single or multiple upstreams
 *   - Redirect mode (`=> target`)
 *   - Static / welcome-page (no mode)
 *   - HTTP Basic Auth via `user:pass@host`
 *   - IP allow-list via `[ip,ip,...] host`
 *   - Per-domain `#stage` override of ACME CA
 *
 * Global env vars affecting the output: STAGE, FORCE_RENEW, HSTS_MAX_AGE,
 * CERTIFICATE_ALGORITHM, NUMBITS, REDIRECT_CODE.
 */
export function renderCaddyfile(config: Config): string {
  const blocks: string[] = [];
  blocks.push(renderGlobalBlock(config));
  for (const domain of config.domains) {
    blocks.push(renderSiteBlock(domain, config));
  }
  return blocks.join('\n\n') + '\n';
}

function renderGlobalBlock(config: Config): string {
  const lines: string[] = ['{'];
  lines.push(`\tstorage file_system ${config.portalBaseDir}/caddy`);
  lines.push(`\tadmin localhost:2019`);

  const defaultCa = acmeDirectoryFor(config.stage);
  if (defaultCa !== null) {
    lines.push(`\tacme_ca ${defaultCa}`);
  }

  if (config.keepAliveTimeout !== null) {
    lines.push(`\tservers {`);
    lines.push(`\t\ttimeouts {`);
    lines.push(`\t\t\tidle ${config.keepAliveTimeout}`);
    lines.push(`\t\t}`);
    lines.push(`\t}`);
  }

  // Caddy's "default" logger captures any log not routed to a named logger;
  // we wire it to the configured error log target / level.
  const errorTarget = renderLogOutput(config.errorLog);
  if (errorTarget !== null) {
    lines.push(`\tlog default {`);
    lines.push(`\t\toutput ${errorTarget}`);
    lines.push(`\t\tlevel ${config.errorLogLevel}`);
    lines.push(`\t}`);
  }

  if (config.customGlobalBlock !== null) {
    appendIndented(lines, config.customGlobalBlock);
  }

  lines.push('}');
  return lines.join('\n');
}

function renderSiteBlock(domain: Domain, config: Config): string {
  const lines: string[] = [];
  lines.push(`${siteAddress(domain)} {`);

  const tlsBlock = renderTlsBlock(domain, config);
  if (tlsBlock !== null) appendIndented(lines, tlsBlock);

  if (config.hstsMaxAge !== null) {
    lines.push(`\theader Strict-Transport-Security "max-age=${config.hstsMaxAge}"`);
  }

  if (config.compressionEnabled) {
    lines.push(`\tencode zstd gzip`);
  }

  if (config.clientMaxBodySize !== null) {
    lines.push(`\trequest_body {`);
    lines.push(`\t\tmax_size ${config.clientMaxBodySize}`);
    lines.push(`\t}`);
  }

  const accessLogOutput = renderLogOutput(config.accessLog);
  if (accessLogOutput !== null) {
    lines.push(`\tlog {`);
    lines.push(`\t\toutput ${accessLogOutput}`);
    lines.push(`\t\tformat json`);
    lines.push(`\t}`);
  }

  if (config.customSiteBlock !== null) {
    appendIndented(lines, config.customSiteBlock);
  }
  const perDomainOverride = config.customSiteBlockFor(domain.envFormatName);
  if (perDomainOverride !== null) {
    appendIndented(lines, perDomainOverride);
  }

  appendSiteBody(lines, domain, config);
  lines.push('}');
  return lines.join('\n');
}

/**
 * `tls` block for the site. Combines:
 *   - `tls internal` for local-stage sites
 *   - explicit ACME issuer override when per-site stage diverges from global
 *   - key_type override when non-default
 */
function renderTlsBlock(domain: Domain, config: Config): string | null {
  if (domain.stage === 'local') return 'tls internal';

  const domainCa = acmeDirectoryFor(domain.stage);
  const globalCa = acmeDirectoryFor(config.stage);
  const needsIssuerOverride = domainCa !== null && domainCa !== globalCa;
  const needsKeyType = config.keyType !== 'rsa2048';

  if (!needsIssuerOverride && !needsKeyType) return null;

  const lines: string[] = ['tls {'];
  if (needsKeyType) lines.push(`\tkey_type ${config.keyType}`);
  if (needsIssuerOverride) {
    lines.push(`\tissuer acme {`);
    lines.push(`\t\tca ${domainCa}`);
    lines.push(`\t}`);
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * Emits the site's request-handling logic.
 *
 * Without IP restriction: flat directives.
 * With IP restriction: two `handle` blocks — disallowed IPs short-circuit to
 * 403, allowed IPs proceed through basic_auth (if any) and the body.
 */
function appendSiteBody(lines: string[], domain: Domain, config: Config): void {
  const innerLines = renderInnerHandlers(domain, config);

  if (domain.accessRestriction === null) {
    for (const l of innerLines) lines.push(`\t${l}`);
    return;
  }

  const ips = domain.accessRestriction.join(' ');
  lines.push(`\t@disallowed not remote_ip ${ips}`);
  lines.push(`\thandle @disallowed {`);
  lines.push(`\t\trespond 403`);
  lines.push(`\t}`);
  lines.push(`\thandle {`);
  for (const l of innerLines) lines.push(`\t\t${l}`);
  lines.push(`\t}`);
}

function renderInnerHandlers(domain: Domain, config: Config): string[] {
  const out: string[] = [];

  if (domain.basicAuthEnabled) {
    out.push('basic_auth {');
    out.push(`\t${domain.basicAuthUsername} ${bcryptHash(domain.basicAuthPassword!)}`);
    out.push('}');
  }

  if (domain.upstream !== null) {
    out.push(...renderReverseProxy(domain, config));
  } else if (domain.redirectTargetUrl !== null) {
    out.push(`redir ${domain.redirectTargetUrl}{uri} ${config.redirectCode}`);
  } else {
    out.push(`root * ${domain.wwwRoot}`);
    if (config.indexFiles.length > 0 && !(config.indexFiles.length === 1 && config.indexFiles[0] === 'index.html')) {
      out.push(`file_server {`);
      out.push(`\tindex ${config.indexFiles.join(' ')}`);
      out.push(`}`);
    } else {
      out.push(`file_server`);
    }
  }

  return out;
}

function renderReverseProxy(domain: Domain, config: Config): string[] {
  const proto = domain.upstreamProto ?? 'http://';
  const targets = domain.upstreams.map((u) => {
    if (u.parameters !== null) {
      console.warn(
        `[caddy-portal] Upstream parameters not supported and will be ignored: ` +
          `"${u.address}[${u.parameters}]" on ${domain.name}. ` +
          `nginx-style weight=/backup/max_conns= don't translate to Caddy.`,
      );
    }
    return `${proto}${u.address}`;
  });

  const timeouts = config.proxyTimeouts;
  const hasTimeouts = timeouts.connect || timeouts.read || timeouts.write;

  if (!hasTimeouts) {
    return [`reverse_proxy ${targets.join(' ')}`];
  }

  const block: string[] = [`reverse_proxy ${targets.join(' ')} {`];
  block.push(`\ttransport http {`);
  if (timeouts.connect) block.push(`\t\tdial_timeout ${timeouts.connect}`);
  if (timeouts.read) block.push(`\t\tread_timeout ${timeouts.read}`);
  if (timeouts.write) block.push(`\t\twrite_timeout ${timeouts.write}`);
  block.push(`\t}`);
  block.push(`}`);
  return block;
}

function siteAddress(domain: Domain): string {
  return domain.port === '443' ? domain.name : `${domain.name}:${domain.port}`;
}

function acmeDirectoryFor(stage: Stage | null): string | null {
  switch (stage) {
    case 'production':
      return 'https://acme-v02.api.letsencrypt.org/directory';
    case 'staging':
      return 'https://acme-staging-v02.api.letsencrypt.org/directory';
    case 'local':
    default:
      return null;
  }
}

function appendIndented(lines: string[], block: string): void {
  for (const line of block.split('\n')) lines.push(`\t${line}`);
}

/** Convert a LogTarget to a Caddy `output` argument, or null when logging is off. */
function renderLogOutput(target: LogTarget): string | null {
  switch (target.kind) {
    case 'off':
      return null;
    case 'stdout':
      return 'stdout';
    case 'stderr':
      return 'stderr';
    case 'file':
      return `file ${target.path}`;
  }
}

/**
 * Caddy's `basic_auth` directive expects bcrypt hashes. We hash on every
 * render to keep things simple; the cost is sub-second even for a handful of
 * domains and config reloads are rare.
 */
function bcryptHash(plaintext: string): string {
  return bcrypt.hashSync(plaintext, 10);
}
