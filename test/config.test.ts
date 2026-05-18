import { describe, it, expect } from 'vitest';
import { Config } from '../src/config.js';

function makeConfig(env: Record<string, string>, autoDiscovered?: string) {
  return new Config(
    env,
    () => autoDiscovered ?? '',
    () => autoDiscovered !== undefined,
  );
}

describe('Config', () => {
  describe('stage', () => {
    it('defaults to staging when no STAGE and no PRODUCTION', () => {
      expect(makeConfig({}).stage).toBe('staging');
    });

    it('honors STAGE=production', () => {
      expect(makeConfig({ STAGE: 'production' }).stage).toBe('production');
    });

    it('honors STAGE=local', () => {
      expect(makeConfig({ STAGE: 'local' }).stage).toBe('local');
    });

    it('falls back to legacy PRODUCTION=true', () => {
      expect(makeConfig({ PRODUCTION: 'true' }).stage).toBe('production');
    });

    it('ignores unknown STAGE values', () => {
      expect(makeConfig({ STAGE: 'nonsense' }).stage).toBe('staging');
    });
  });

  describe('forceRenew', () => {
    it('reads FORCE_RENEW=true case-insensitively', () => {
      expect(makeConfig({ FORCE_RENEW: 'TRUE' }).forceRenew).toBe(true);
      expect(makeConfig({ FORCE_RENEW: 'true' }).forceRenew).toBe(true);
      expect(makeConfig({ FORCE_RENEW: 'false' }).forceRenew).toBe(false);
      expect(makeConfig({}).forceRenew).toBe(false);
    });
  });

  describe('renewMarginDays', () => {
    it('defaults to 30', () => {
      expect(makeConfig({}).renewMarginDays).toBe(30);
    });

    it('honors a valid integer', () => {
      expect(makeConfig({ RENEW_MARGIN_DAYS: '14' }).renewMarginDays).toBe(14);
    });

    it('falls back to 30 on garbage input', () => {
      expect(makeConfig({ RENEW_MARGIN_DAYS: 'abc' }).renewMarginDays).toBe(30);
      expect(makeConfig({ RENEW_MARGIN_DAYS: '0' }).renewMarginDays).toBe(30);
    });
  });

  describe('keyType', () => {
    it('defaults to rsa2048', () => {
      expect(makeConfig({}).keyType).toBe('rsa2048');
    });

    it('maps NUMBITS=4096 to rsa4096', () => {
      expect(makeConfig({ NUMBITS: '4096' }).keyType).toBe('rsa4096');
    });

    it('maps CERTIFICATE_ALGORITHM=prime256v1 to p256', () => {
      expect(makeConfig({ CERTIFICATE_ALGORITHM: 'prime256v1' }).keyType).toBe('p256');
    });
  });

  describe('domains', () => {
    it('parses DOMAINS env into Domain objects', () => {
      const cfg = makeConfig({ DOMAINS: 'a.com, b.com -> http://app' });
      expect(cfg.domains.map((d) => d.name)).toEqual(['a.com', 'b.com']);
    });

    it('merges DOMAINS env with /var/run/domains contents', () => {
      const cfg = makeConfig({ DOMAINS: 'a.com' }, 'b.com -> http://app');
      expect(cfg.domains.map((d) => d.name)).toEqual(['a.com', 'b.com']);
    });

    it('dedupes by (name, port) for the general domain list', () => {
      const cfg = makeConfig({ DOMAINS: 'a.com, a.com:443, a.com:8443' });
      expect(cfg.domains.map((d) => `${d.name}:${d.port}`)).toEqual([
        'a.com:443',
        'a.com:8443',
      ]);
    });

    it('dedupes by name only for cert issuance', () => {
      const cfg = makeConfig({ DOMAINS: 'a.com:443, a.com:8443, b.com' });
      expect(cfg.domainsWithUniqueNames.map((d) => d.name)).toEqual(['a.com', 'b.com']);
    });

    it('inherits configured stage as default for per-domain parsing', () => {
      const cfg = makeConfig({ STAGE: 'production', DOMAINS: 'a.com, b.com #staging' });
      expect(cfg.domains[0]!.stage).toBe('production');
      expect(cfg.domains[1]!.stage).toBe('staging');
    });
  });
});
