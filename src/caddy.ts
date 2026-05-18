import type { Domain, Stage } from './domain.js';
import type { Config } from './config.js';

/**
 * Render a complete Caddyfile from the runtime config.
 *
 * Layout:
 *   - One global options block: storage, admin, default ACME CA (if not local)
 *   - One site block per domain (no port collapsing — Caddy handles bundling)
 *
 * MVP scope (matches Day-1 sprint):
 *   - Proxy mode (`-> upstream`) with single upstream + proto
 *   - Redirect mode (`=> target`)
 *   - Static / welcome-page (no mode)
 *   - Per-domain `#stage` override of ACME CA
 *
 * Not yet emitted (next pass): basic auth, IP restriction, multi-upstream
 * with load balancing, HSTS, custom logging, websockets (auto-handled by Caddy
 * but we may want explicit tuning).
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
  lines.push('}');
  return lines.join('\n');
}

function renderSiteBlock(domain: Domain, config: Config): string {
  const lines: string[] = [];
  lines.push(`${siteAddress(domain)} {`);

  const tlsLine = renderTlsBlock(domain, config);
  if (tlsLine !== null) lines.push(indent(tlsLine));

  const body = renderSiteBody(domain, config);
  for (const bodyLine of body) lines.push(indent(bodyLine));

  lines.push('}');
  return lines.join('\n');
}

/**
 * `tls` configuration for the site:
 *   - local stage → `tls internal` (Caddy's local CA)
 *   - per-site stage matches global → no tls directive (inherits global acme_ca)
 *   - per-site stage diverges → explicit issuer override
 */
function renderTlsBlock(domain: Domain, config: Config): string | null {
  if (domain.stage === 'local') return 'tls internal';

  const domainCa = acmeDirectoryFor(domain.stage);
  const globalCa = acmeDirectoryFor(config.stage);
  if (domainCa === null || domainCa === globalCa) return null;

  return [
    'tls {',
    `\tissuer acme {`,
    `\t\tca ${domainCa}`,
    `\t}`,
    '}',
  ].join('\n');
}

function renderSiteBody(domain: Domain, config: Config): string[] {
  if (domain.upstream !== null) {
    return [`reverse_proxy ${domain.upstream}`];
  }

  if (domain.redirectTargetUrl !== null) {
    return [`redir ${domain.redirectTargetUrl}{uri} ${config.redirectCode}`];
  }

  return [
    `root * ${domain.wwwRoot}`,
    `file_server`,
  ];
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

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `\t${line}`)
    .join('\n');
}
