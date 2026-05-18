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
