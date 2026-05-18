import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Stage } from './domain.js';

/**
 * One-shot import of certificates from the original https-portal layout into
 * Caddy's storage. Triggered by MIGRATE_FROM_NGINX=true. Writes a marker file
 * so subsequent starts skip the import.
 *
 * Original layout:
 *   <portalBaseDir>/<domain>/<stage>/{signed.crt, chained.crt, domain.key}
 *
 * Caddy target layout (under <portalBaseDir>/caddy/):
 *   certificates/<issuer_key>/<domain>/{<domain>.crt, <domain>.key, <domain>.json}
 *
 * Caveats:
 *   - Local-stage certs are not migrated (Caddy reissues via its internal CA).
 *   - The metadata JSON is intentionally minimal. If Caddy refuses to load it
 *     (e.g. due to a certmagic schema bump), it falls back to reissuing via
 *     the configured ACME CA — same outcome as a cold start.
 */
export function migrateLegacyCerts(
  options: {
    portalBaseDir?: string;
    enabled?: boolean;
    fs?: MigrationFs;
    logger?: { info: (msg: string) => void; warn: (msg: string) => void };
  } = {},
): { imported: string[]; skipped: string[] } {
  const portalBaseDir = options.portalBaseDir ?? '/var/lib/https-portal';
  const enabled = options.enabled ?? process.env.MIGRATE_FROM_NGINX?.toLowerCase() === 'true';
  const fs = options.fs ?? defaultFs;
  const logger = options.logger ?? console;

  const marker = join(portalBaseDir, '.migrated-from-nginx');
  if (!enabled) return { imported: [], skipped: [] };
  if (fs.exists(marker)) {
    logger.info(`[caddy-portal] Migration marker present at ${marker}, skipping legacy cert import.`);
    return { imported: [], skipped: [] };
  }

  const imported: string[] = [];
  const skipped: string[] = [];

  for (const domainDir of listSubdirs(portalBaseDir, fs)) {
    if (domainDir === 'caddy' || domainDir.startsWith('.')) continue;
    if (domainDir === 'default_server' || domainDir === 'dynamic-env') continue;
    if (!isLikelyDomain(domainDir)) continue;

    for (const stage of ['production', 'staging'] as const) {
      const stageDir = join(portalBaseDir, domainDir, stage);
      if (!fs.exists(stageDir)) continue;

      const result = importDomainCert(domainDir, stage, stageDir, portalBaseDir, fs, logger);
      if (result === 'imported') imported.push(`${domainDir} (${stage})`);
      else if (result === 'skipped') skipped.push(`${domainDir} (${stage})`);
    }
  }

  fs.writeFile(marker, new Date().toISOString());
  logger.info(`[caddy-portal] Migration complete: ${imported.length} imported, ${skipped.length} skipped.`);
  return { imported, skipped };
}

function importDomainCert(
  domain: string,
  stage: Stage,
  stageDir: string,
  portalBaseDir: string,
  fs: MigrationFs,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): 'imported' | 'skipped' | 'no-cert' {
  // Prefer chained.crt (full chain) over signed.crt (leaf only)
  const certCandidates = [join(stageDir, 'chained.crt'), join(stageDir, 'signed.crt')];
  const keyPath = join(stageDir, 'domain.key');

  const certPath = certCandidates.find((p) => fs.exists(p));
  if (!certPath || !fs.exists(keyPath)) {
    return 'no-cert';
  }

  const issuerKey = issuerKeyForStage(stage);
  const targetDir = join(portalBaseDir, 'caddy', 'certificates', issuerKey, domain);
  fs.mkdirp(targetDir);

  fs.copyFile(certPath, join(targetDir, `${domain}.crt`));
  fs.copyFile(keyPath, join(targetDir, `${domain}.key`));
  fs.writeFile(
    join(targetDir, `${domain}.json`),
    JSON.stringify({ sans: [domain], issuer_key: 'acme' }, null, 2),
  );

  logger.info(`[caddy-portal] Imported cert for ${domain} (${stage}) from ${certPath}`);
  return 'imported';
}

function issuerKeyForStage(stage: Stage): string {
  return stage === 'production'
    ? 'acme-v02.api.letsencrypt.org-directory'
    : 'acme-staging-v02.api.letsencrypt.org-directory';
}

function listSubdirs(base: string, fs: MigrationFs): string[] {
  if (!fs.exists(base)) return [];
  return fs.readdir(base).filter((entry) => {
    const fullPath = join(base, entry);
    return fs.isDirectory(fullPath);
  });
}

function isLikelyDomain(name: string): boolean {
  return /^[a-z0-9._-]+$/i.test(name) && name.includes('.');
}

export interface MigrationFs {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readdir(path: string): string[];
  mkdirp(path: string): void;
  copyFile(src: string, dest: string): void;
  writeFile(path: string, contents: string): void;
}

const defaultFs: MigrationFs = {
  exists: (p) => existsSync(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: (p) => readdirSync(p),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  copyFile: (s, d) => copyFileSync(s, d),
  writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
};
