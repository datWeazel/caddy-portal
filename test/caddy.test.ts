import { describe, it, expect } from 'vitest';
import { renderCaddyfile } from '../src/caddy.js';
import { Config } from '../src/config.js';

function configWith(env: Record<string, string>) {
  return new Config(
    env,
    () => '',
    () => false,
  );
}

describe('renderCaddyfile — global block', () => {
  it('omits acme_ca when STAGE=local', () => {
    const cfg = configWith({ STAGE: 'local', DOMAINS: 'a.local' });
    const out = renderCaddyfile(cfg);
    expect(out).not.toContain('acme_ca');
    expect(out).toContain('storage file_system /var/lib/https-portal/caddy');
    expect(out).toContain('admin localhost:2019');
  });

  it('sets staging acme_ca by default', () => {
    const cfg = configWith({ DOMAINS: 'a.com' });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('acme_ca https://acme-staging-v02.api.letsencrypt.org/directory');
  });

  it('sets production acme_ca when STAGE=production', () => {
    const cfg = configWith({ STAGE: 'production', DOMAINS: 'a.com' });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('acme_ca https://acme-v02.api.letsencrypt.org/directory');
  });
});

describe('renderCaddyfile — per-site blocks', () => {
  it('renders a welcome-page (static) site', () => {
    const cfg = configWith({ STAGE: 'local', DOMAINS: 'example.com' });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('example.com {');
    expect(out).toContain('tls internal');
    expect(out).toContain('root * /var/www/vhosts/example.com');
    expect(out).toContain('file_server');
  });

  it('renders a reverse-proxy site', () => {
    const cfg = configWith({ STAGE: 'local', DOMAINS: 'example.com -> http://app:8080' });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('reverse_proxy http://app:8080');
    expect(out).not.toContain('file_server');
  });

  it('renders a redirect with default 307', () => {
    const cfg = configWith({ STAGE: 'local', DOMAINS: 'old.com => https://new.com' });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('redir https://new.com{uri} 307');
  });

  it('honors REDIRECT_CODE=301', () => {
    const cfg = configWith({
      STAGE: 'local',
      REDIRECT_CODE: '301',
      DOMAINS: 'old.com => https://new.com',
    });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('redir https://new.com{uri} 301');
  });

  it('appends custom port to site address', () => {
    const cfg = configWith({ STAGE: 'local', DOMAINS: 'app.com:8443 -> http://up:80' });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('app.com:8443 {');
  });

  it('omits port suffix for default 443', () => {
    const cfg = configWith({ STAGE: 'local', DOMAINS: 'app.com -> http://up:80' });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('app.com {');
    expect(out).not.toContain('app.com:443');
  });
});

describe('renderCaddyfile — per-site TLS overrides', () => {
  it('uses tls internal for local-stage sites under non-local global', () => {
    const cfg = configWith({ STAGE: 'production', DOMAINS: 'a.com, dev.local #local' });
    const out = renderCaddyfile(cfg);
    const devBlock = sliceBlock(out, 'dev.local');
    expect(devBlock).toContain('tls internal');
  });

  it('writes explicit issuer override for staging site under production default', () => {
    const cfg = configWith({ STAGE: 'production', DOMAINS: 'a.com, b.com #staging' });
    const out = renderCaddyfile(cfg);
    const bBlock = sliceBlock(out, 'b.com');
    expect(bBlock).toContain('issuer acme');
    expect(bBlock).toContain('ca https://acme-staging-v02.api.letsencrypt.org/directory');
  });

  it('inherits global ACME when site stage matches default', () => {
    const cfg = configWith({ STAGE: 'staging', DOMAINS: 'a.com, b.com #staging' });
    const out = renderCaddyfile(cfg);
    const bBlock = sliceBlock(out, 'b.com');
    expect(bBlock).not.toContain('issuer acme');
  });
});

describe('renderCaddyfile — site-level features', () => {
  it('emits basic_auth block with bcrypt hash', () => {
    const cfg = configWith({ STAGE: 'local', DOMAINS: 'user:secret@a.com -> http://app' });
    const out = renderCaddyfile(cfg);
    expect(out).toMatch(/basic_auth \{/);
    expect(out).toMatch(/user \$2[aby]?\$\d+\$/);
  });

  it('emits IP allow-list with handle blocks', () => {
    const cfg = configWith({
      STAGE: 'local',
      DOMAINS: '[1.2.3.4/24 5.6.7.8] a.com -> http://app',
    });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('@disallowed not remote_ip 1.2.3.4/24 5.6.7.8');
    expect(out).toContain('handle @disallowed {');
    expect(out).toContain('respond 403');
    expect(out).toContain('handle {');
    const aBlock = sliceBlock(out, 'a.com');
    expect(aBlock).toContain('reverse_proxy http://app');
  });

  it('combines IP restriction, basic auth and proxy in correct order', () => {
    const cfg = configWith({
      STAGE: 'local',
      DOMAINS: '[1.2.3.4]user:pass@a.com -> http://app',
    });
    const out = renderCaddyfile(cfg);
    const aBlock = sliceBlock(out, 'a.com');
    const idxDisallowed = aBlock.indexOf('@disallowed');
    const idxBasicAuth = aBlock.indexOf('basic_auth');
    const idxProxy = aBlock.indexOf('reverse_proxy');
    expect(idxDisallowed).toBeGreaterThan(-1);
    expect(idxBasicAuth).toBeGreaterThan(idxDisallowed);
    expect(idxProxy).toBeGreaterThan(idxBasicAuth);
  });

  it('emits multi-upstream proxy with all addresses', () => {
    const cfg = configWith({
      STAGE: 'local',
      DOMAINS: 'a.com -> https://target1|target2:8000',
    });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('reverse_proxy https://target1 https://target2:8000');
  });

  it('ignores upstream parameters but renders address', () => {
    const cfg = configWith({
      STAGE: 'local',
      DOMAINS: 'a.com -> http://target1|target2[backup max_conns=100]',
    });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('reverse_proxy http://target1 http://target2');
  });

  it('emits HSTS header when HSTS_MAX_AGE set', () => {
    const cfg = configWith({
      STAGE: 'local',
      HSTS_MAX_AGE: '31536000',
      DOMAINS: 'a.com -> http://app',
    });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('header Strict-Transport-Security "max-age=31536000"');
  });

  it('omits HSTS header by default', () => {
    const cfg = configWith({ STAGE: 'local', DOMAINS: 'a.com' });
    expect(renderCaddyfile(cfg)).not.toContain('Strict-Transport-Security');
  });

  it('emits key_type override for non-rsa2048', () => {
    const cfg = configWith({
      STAGE: 'production',
      CERTIFICATE_ALGORITHM: 'prime256v1',
      DOMAINS: 'a.com',
    });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('key_type p256');
  });

  it('omits tls block entirely when no overrides apply', () => {
    const cfg = configWith({ STAGE: 'staging', DOMAINS: 'a.com' });
    const out = renderCaddyfile(cfg);
    const aBlock = sliceBlock(out, 'a.com');
    expect(aBlock).not.toContain('tls');
  });

  it('emits disable_tlsalpn_challenge when DISABLE_TLS_ALPN_CHALLENGE=true', () => {
    const cfg = configWith({
      STAGE: 'production',
      DISABLE_TLS_ALPN_CHALLENGE: 'true',
      DOMAINS: 'a.com',
    });
    const out = renderCaddyfile(cfg);
    const aBlock = sliceBlock(out, 'a.com');
    expect(aBlock).toContain('issuer acme {');
    expect(aBlock).toContain('disable_tlsalpn_challenge');
  });

  it('combines disable_tlsalpn_challenge with per-site stage override', () => {
    const cfg = configWith({
      STAGE: 'production',
      DISABLE_TLS_ALPN_CHALLENGE: 'true',
      DOMAINS: 'a.com #staging',
    });
    const out = renderCaddyfile(cfg);
    const aBlock = sliceBlock(out, 'a.com');
    expect(aBlock).toContain('ca https://acme-staging-v02.api.letsencrypt.org/directory');
    expect(aBlock).toContain('disable_tlsalpn_challenge');
  });

  it('combines disable_tlsalpn_challenge with key_type override', () => {
    const cfg = configWith({
      STAGE: 'production',
      DISABLE_TLS_ALPN_CHALLENGE: 'true',
      CERTIFICATE_ALGORITHM: 'prime256v1',
      DOMAINS: 'a.com',
    });
    const out = renderCaddyfile(cfg);
    const aBlock = sliceBlock(out, 'a.com');
    expect(aBlock).toContain('key_type p256');
    expect(aBlock).toContain('disable_tlsalpn_challenge');
  });

  it('does not emit issuer override for local-stage sites when DISABLE_TLS_ALPN_CHALLENGE=true', () => {
    const cfg = configWith({
      STAGE: 'local',
      DISABLE_TLS_ALPN_CHALLENGE: 'true',
      DOMAINS: 'a.local',
    });
    const out = renderCaddyfile(cfg);
    const aBlock = sliceBlock(out, 'a.local');
    expect(aBlock).toContain('tls internal');
    expect(aBlock).not.toContain('disable_tlsalpn_challenge');
  });
});

describe('renderCaddyfile — global knobs', () => {
  it('emits encode zstd gzip by default', () => {
    const cfg = configWith({ STAGE: 'local', DOMAINS: 'a.com' });
    expect(renderCaddyfile(cfg)).toContain('encode zstd gzip');
  });

  it('omits encode when GZIP=off', () => {
    const cfg = configWith({ STAGE: 'local', GZIP: 'off', DOMAINS: 'a.com' });
    expect(renderCaddyfile(cfg)).not.toContain('encode');
  });

  it('emits request_body max_size when CLIENT_MAX_BODY_SIZE set', () => {
    const cfg = configWith({
      STAGE: 'local',
      CLIENT_MAX_BODY_SIZE: '20MB',
      DOMAINS: 'a.com -> http://app',
    });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('request_body');
    expect(out).toContain('max_size 20MB');
  });

  it('emits keepalive idle timeout in global servers block', () => {
    const cfg = configWith({ STAGE: 'local', KEEPALIVE_TIMEOUT: '90', DOMAINS: 'a.com' });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('servers {');
    expect(out).toContain('idle 90s');
  });

  it('emits proxy timeouts when PROXY_*_TIMEOUT set', () => {
    const cfg = configWith({
      STAGE: 'local',
      PROXY_CONNECT_TIMEOUT: '10',
      PROXY_READ_TIMEOUT: '120',
      DOMAINS: 'a.com -> http://app',
    });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('transport http');
    expect(out).toContain('dial_timeout 10s');
    expect(out).toContain('read_timeout 120s');
  });

  it('emits per-site access log when ACCESS_LOG=stdout', () => {
    const cfg = configWith({ STAGE: 'local', ACCESS_LOG: 'stdout', DOMAINS: 'a.com' });
    const out = renderCaddyfile(cfg);
    const block = sliceBlock(out, 'a.com');
    expect(block).toContain('log {');
    expect(block).toContain('output stdout');
    expect(block).toContain('format json');
  });

  it('emits ACCESS_LOG=default as file output', () => {
    const cfg = configWith({ STAGE: 'local', ACCESS_LOG: 'default', DOMAINS: 'a.com' });
    expect(renderCaddyfile(cfg)).toContain('output file /var/log/caddy/access.log');
  });

  it('emits global error log default to stderr', () => {
    const cfg = configWith({ STAGE: 'local', DOMAINS: 'a.com' });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('log default {');
    expect(out).toContain('output stderr');
    expect(out).toContain('level ERROR');
  });

  it('honors ERROR_LOG_LEVEL', () => {
    const cfg = configWith({ STAGE: 'local', ERROR_LOG_LEVEL: 'debug', DOMAINS: 'a.com' });
    expect(renderCaddyfile(cfg)).toContain('level DEBUG');
  });

  it('emits file_server with custom index files', () => {
    const cfg = configWith({
      STAGE: 'local',
      INDEX_FILES: 'index.html index.htm welcome.html',
      DOMAINS: 'a.com',
    });
    const out = renderCaddyfile(cfg);
    expect(out).toContain('index index.html index.htm welcome.html');
  });
});

describe('renderCaddyfile — CUSTOM_CADDY_* overrides', () => {
  it('splices CUSTOM_CADDY_GLOBAL_BLOCK into the global options block', () => {
    const cfg = configWith({
      STAGE: 'local',
      CUSTOM_CADDY_GLOBAL_BLOCK: 'email admin@example.com',
      DOMAINS: 'a.com',
    });
    const out = renderCaddyfile(cfg);
    expect(out.split('\n').slice(0, 8).join('\n')).toContain('email admin@example.com');
  });

  it('splices CUSTOM_CADDY_SERVER_BLOCK into every site', () => {
    const cfg = configWith({
      STAGE: 'local',
      CUSTOM_CADDY_SERVER_BLOCK: 'header X-Frame-Options DENY',
      DOMAINS: 'a.com, b.com',
    });
    const out = renderCaddyfile(cfg);
    const matches = out.match(/X-Frame-Options DENY/g);
    expect(matches?.length).toBe(2);
  });

  it('splices per-domain CUSTOM_CADDY_<DOMAIN>_BLOCK into the matching site only', () => {
    const cfg = configWith({
      STAGE: 'local',
      CUSTOM_CADDY_A_COM_BLOCK: 'header X-Site a',
      DOMAINS: 'a.com, b.com',
    });
    const out = renderCaddyfile(cfg);
    expect(sliceBlock(out, 'a.com')).toContain('X-Site a');
    expect(sliceBlock(out, 'b.com')).not.toContain('X-Site a');
  });
});

describe('renderCaddyfile — multiple domains', () => {
  it('emits one block per domain', () => {
    const cfg = configWith({
      STAGE: 'local',
      DOMAINS: 'a.local, b.local -> http://b, c.local => https://elsewhere.com',
    });
    const out = renderCaddyfile(cfg);
    expect(out.match(/^[a-z.]+ \{$/gm)?.length).toBe(3);
  });
});

/** Helper: extract the `{ ... }` body of a named site block from rendered Caddyfile output. */
function sliceBlock(caddyfile: string, siteName: string): string {
  const lines = caddyfile.split('\n');
  const startIdx = lines.findIndex((l) => l.startsWith(`${siteName} `) || l === `${siteName} {`);
  if (startIdx === -1) throw new Error(`No block for site ${siteName} in:\n${caddyfile}`);
  let depth = 0;
  const out: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    depth += (line.match(/\{/g)?.length ?? 0);
    depth -= (line.match(/\}/g)?.length ?? 0);
    if (depth === 0 && i > startIdx) break;
  }
  return out.join('\n');
}
