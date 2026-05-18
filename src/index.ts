import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Config } from './config.js';
import { renderCaddyfile } from './caddy.js';
import { ensureWelcomePage } from './welcome.js';
import { reportCompatibilityIssues } from './compatibility.js';
import { migrateLegacyCerts } from './migration.js';

const CADDYFILE_PATH = process.env.CADDYFILE_PATH ?? '/etc/caddy/Caddyfile';

function main(argv: string[]): number {
  const command = argv[0] ?? 'render';

  switch (command) {
    case 'render':
      return renderCommand();
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      return 1;
  }
}

function renderCommand(): number {
  reportCompatibilityIssues();

  const config = new Config();

  migrateLegacyCerts({ portalBaseDir: config.portalBaseDir });

  for (const domain of config.domains) ensureWelcomePage(domain);

  const caddyfile = renderCaddyfile(config);
  mkdirSync(dirname(CADDYFILE_PATH), { recursive: true });
  writeFileSync(CADDYFILE_PATH, caddyfile, 'utf8');

  console.log(`[caddy-portal] Wrote ${CADDYFILE_PATH} (${config.domains.length} domain(s), stage=${config.stage})`);
  return 0;
}

function printUsage(): void {
  console.log(`caddy-portal — automatic HTTPS via Caddy

Usage:
  portal render   Render the Caddyfile from environment variables
  portal help     Show this message

Environment:
  DOMAINS          Comma-separated descriptors (see README)
  STAGE            production | staging | local   (default: staging)
  FORCE_RENEW      true to force certificate renewal
  REDIRECT_CODE    301 | 302 | 307 | 308          (default: 307)
  CERTIFICATE_ALGORITHM  prime256v1 → p256 key type
  NUMBITS          RSA key bits (2048 or 4096)
  CADDYFILE_PATH   Where to write the rendered file (default: /etc/caddy/Caddyfile)
`);
}

process.exitCode = main(process.argv.slice(2));
