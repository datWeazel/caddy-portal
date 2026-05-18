import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Domain } from './domain.js';

/**
 * For domains without an upstream or redirect target, drop an index.html at
 * `domain.wwwRoot` so file_server has something to serve. Skip if the user
 * has already mounted their own content.
 *
 * Mirrors Domain#ensure_welcome_page from the original Ruby implementation.
 */
export function ensureWelcomePage(
  domain: Domain,
  options: { fileWriter?: WelcomePageWriter } = {},
): void {
  if (domain.upstream !== null || domain.redirectTargetUrl !== null) return;

  const writer = options.fileWriter ?? defaultWriter;
  const indexPath = join(domain.wwwRoot, 'index.html');
  if (writer.exists(indexPath)) return;

  writer.mkdirp(domain.wwwRoot);
  writer.write(indexPath, renderWelcomeHtml(domain));
}

export function renderWelcomeHtml(domain: Domain): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Welcome to caddy-portal</title>
  <style>
    body { width: 35em; margin: 2em auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; line-height: 1.5; color: #1a1a1a; }
    code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.95em; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <h1>Welcome to caddy-portal</h1>
  ${stageParagraph(domain)}
  <p>You can replace this page with your own static files by mounting your
     own document root to <code>${domain.wwwRoot}</code>.</p>
  <p>Documentation: <a href="https://github.com/datWeazel/caddy-portal">github.com/datWeazel/caddy-portal</a></p>
</body>
</html>
`;
}

function stageParagraph(domain: Domain): string {
  switch (domain.stage) {
    case 'production':
      return `<p>Your site is available over HTTPS with a certificate issued by
              <a href="https://letsencrypt.org">Let's Encrypt</a>.</p>`;
    case 'staging':
      return `<p>Your site is available over HTTPS with a test certificate from
              <a href="https://letsencrypt.org">Let's Encrypt</a>'s staging server.
              Your browser will not trust it.</p>
              <p>To switch to production, set <code>STAGE=production</code> in
              the container environment.</p>`;
    case 'local':
      return `<p>Your site is available over HTTPS with a self-signed certificate
              issued by Caddy's local CA. Your browser will not trust it unless
              you install Caddy's root certificate.</p>`;
    default:
      return '';
  }
}

interface WelcomePageWriter {
  exists(path: string): boolean;
  mkdirp(path: string): void;
  write(path: string, contents: string): void;
}

const defaultWriter: WelcomePageWriter = {
  exists: (p) => existsSync(p),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  write: (p, c) => writeFileSync(p, c, 'utf8'),
};
