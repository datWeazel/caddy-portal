import { describe, it, expect, vi } from 'vitest';
import { migrateLegacyCerts, type MigrationFs } from '../src/migration.js';

/** In-memory FS mock that mirrors the subset of FS calls migration uses. */
function makeFs(initialFiles: Record<string, string> = {}, initialDirs: string[] = []) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const dirs = new Set<string>(initialDirs);
  // Auto-derive directories from file paths
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }

  const fs: MigrationFs = {
    exists: (p) => files.has(p) || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    readdir: (p) => {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const direct = new Set<string>();
      for (const entry of [...files.keys(), ...dirs]) {
        if (entry === p || !entry.startsWith(prefix)) continue;
        const rest = entry.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) direct.add(first);
      }
      return [...direct];
    },
    mkdirp: (p) => {
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    },
    copyFile: (src, dest) => {
      const content = files.get(src);
      if (content === undefined) throw new Error(`Missing source: ${src}`);
      files.set(dest, content);
    },
    writeFile: (p, c) => {
      files.set(p, c);
    },
  };

  return { fs, files, dirs };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('migrateLegacyCerts', () => {
  it('does nothing when not enabled', () => {
    const { fs, files } = makeFs({
      '/var/lib/https-portal/example.com/production/signed.crt': 'CERT',
      '/var/lib/https-portal/example.com/production/domain.key': 'KEY',
    });
    const result = migrateLegacyCerts({ enabled: false, fs, logger: makeLogger() });
    expect(result.imported).toEqual([]);
    expect(files.has('/var/lib/https-portal/caddy/certificates/acme-v02.api.letsencrypt.org-directory/example.com/example.com.crt')).toBe(false);
  });

  it('imports a production cert into Caddy storage layout', () => {
    const { fs, files } = makeFs({
      '/var/lib/https-portal/example.com/production/signed.crt': 'CERT',
      '/var/lib/https-portal/example.com/production/domain.key': 'KEY',
    });
    const result = migrateLegacyCerts({ enabled: true, fs, logger: makeLogger() });
    expect(result.imported).toEqual(['example.com (production)']);
    const targetCert = '/var/lib/https-portal/caddy/certificates/acme-v02.api.letsencrypt.org-directory/example.com/example.com.crt';
    expect(files.get(targetCert)).toBe('CERT');
    expect(files.get(targetCert.replace('.crt', '.key'))).toBe('KEY');
    const meta = files.get(targetCert.replace('.crt', '.json'));
    expect(meta).toBeDefined();
    expect(JSON.parse(meta!)).toEqual({ sans: ['example.com'], issuer_key: 'acme' });
  });

  it('prefers chained.crt over signed.crt when both present', () => {
    const { fs, files } = makeFs({
      '/var/lib/https-portal/example.com/production/signed.crt': 'LEAF',
      '/var/lib/https-portal/example.com/production/chained.crt': 'CHAIN',
      '/var/lib/https-portal/example.com/production/domain.key': 'KEY',
    });
    migrateLegacyCerts({ enabled: true, fs, logger: makeLogger() });
    const targetCert = '/var/lib/https-portal/caddy/certificates/acme-v02.api.letsencrypt.org-directory/example.com/example.com.crt';
    expect(files.get(targetCert)).toBe('CHAIN');
  });

  it('routes staging certs to staging issuer path', () => {
    const { fs, files } = makeFs({
      '/var/lib/https-portal/example.com/staging/signed.crt': 'CERT',
      '/var/lib/https-portal/example.com/staging/domain.key': 'KEY',
    });
    migrateLegacyCerts({ enabled: true, fs, logger: makeLogger() });
    expect(
      files.has('/var/lib/https-portal/caddy/certificates/acme-staging-v02.api.letsencrypt.org-directory/example.com/example.com.crt'),
    ).toBe(true);
  });

  it('skips local-stage certs', () => {
    const { fs, files } = makeFs({
      '/var/lib/https-portal/example.com/local/signed.crt': 'CERT',
      '/var/lib/https-portal/example.com/local/domain.key': 'KEY',
    });
    const result = migrateLegacyCerts({ enabled: true, fs, logger: makeLogger() });
    expect(result.imported).toEqual([]);
    expect(files.has('/var/lib/https-portal/caddy/certificates/acme-v02.api.letsencrypt.org-directory/example.com/example.com.crt')).toBe(false);
  });

  it('skips when marker file already exists', () => {
    const { fs, files } = makeFs({
      '/var/lib/https-portal/.migrated-from-nginx': '2026-01-01T00:00:00Z',
      '/var/lib/https-portal/example.com/production/signed.crt': 'CERT',
      '/var/lib/https-portal/example.com/production/domain.key': 'KEY',
    });
    const result = migrateLegacyCerts({ enabled: true, fs, logger: makeLogger() });
    expect(result.imported).toEqual([]);
    expect(files.has('/var/lib/https-portal/caddy/certificates/acme-v02.api.letsencrypt.org-directory/example.com/example.com.crt')).toBe(false);
  });

  it('writes a marker file after running', () => {
    const { fs, files } = makeFs({});
    migrateLegacyCerts({ enabled: true, fs, logger: makeLogger() });
    expect(files.has('/var/lib/https-portal/.migrated-from-nginx')).toBe(true);
  });

  it('ignores caddy/ subdir and internal entries', () => {
    const { fs, files } = makeFs({
      '/var/lib/https-portal/caddy/data/file': 'x',
      '/var/lib/https-portal/default_server/default_server.crt': 'x',
      '/var/lib/https-portal/dynamic-env/SOME_VAR': 'x',
      '/var/lib/https-portal/example.com/production/signed.crt': 'CERT',
      '/var/lib/https-portal/example.com/production/domain.key': 'KEY',
    });
    const result = migrateLegacyCerts({ enabled: true, fs, logger: makeLogger() });
    expect(result.imported).toEqual(['example.com (production)']);
  });

  it('skips entries that do not look like domains', () => {
    const { fs } = makeFs({}, ['/var/lib/https-portal/somefolder']);
    const result = migrateLegacyCerts({ enabled: true, fs, logger: makeLogger() });
    expect(result.imported).toEqual([]);
  });

  it('skips domain dirs that are missing cert or key', () => {
    const { fs, files } = makeFs({
      '/var/lib/https-portal/example.com/production/signed.crt': 'CERT',
      // domain.key missing
    });
    const result = migrateLegacyCerts({ enabled: true, fs, logger: makeLogger() });
    expect(result.imported).toEqual([]);
    expect(files.has('/var/lib/https-portal/caddy/certificates/acme-v02.api.letsencrypt.org-directory/example.com/example.com.crt')).toBe(false);
  });
});
