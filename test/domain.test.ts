import { describe, it, expect } from 'vitest';
import { Domain, parseDomains, InvalidDescriptorError, type Upstream } from '../src/domain.js';

/**
 * Source-of-truth table ported 1:1 from the original https-portal:
 *   spec/models/domain_spec.rb
 *
 * Each row asserts the full parsing outcome. If parity with the original is
 * broken, this fails loudly.
 */
type Row = {
  descriptor: string;
  name: string;
  envFormatName: string;
  upstreamProto: string | null;
  upstreams: Upstream[];
  redirectTargetUrl: string | null;
  stage: 'production' | 'staging' | 'local' | null;
  basicAuthUsername: string | null;
  basicAuthPassword: string | null;
  accessRestriction: string[] | null;
  port: string;
};

const u = (address: string, parameters: string | null = null): Upstream => ({ address, parameters });

const rows: Row[] = [
  { descriptor: 'example.com', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: null, upstreams: [], redirectTargetUrl: null, stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com:4443', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: null, upstreams: [], redirectTargetUrl: null, stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '4443' },
  { descriptor: '4example.com', name: '4example.com', envFormatName: '4EXAMPLE_COM', upstreamProto: null, upstreams: [], redirectTargetUrl: null, stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: ' example.com ', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: null, upstreams: [], redirectTargetUrl: null, stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com #staging', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: null, upstreams: [], redirectTargetUrl: null, stage: 'staging', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com -> http://target ', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: null, stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com \n-> http://target \n', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: null, stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com\n-> http://target ', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: null, stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com -> http://target:8000', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target:8000')], redirectTargetUrl: null, stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com -> target:8000', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target:8000')], redirectTargetUrl: null, stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com => http://target', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: 'http://target', stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com => https://target', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'https://', upstreams: [u('target')], redirectTargetUrl: 'https://target', stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com => target', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'https://', upstreams: [u('target')], redirectTargetUrl: 'https://target', stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com=>http://target', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: 'http://target', stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com -> http://target #staging', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: null, stage: 'staging', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com => http://target #staging', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: 'http://target', stage: 'staging', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com->http://target #staging', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: null, stage: 'staging', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'exam-ple.com->http://tar-get #staging', name: 'exam-ple.com', envFormatName: 'EXAM_PLE_COM', upstreamProto: 'http://', upstreams: [u('tar-get')], redirectTargetUrl: null, stage: 'staging', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example_.com->http://target #staging', name: 'example_.com', envFormatName: 'EXAMPLE__COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: null, stage: 'staging', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com->http://tar_get_ #staging', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('tar_get_')], redirectTargetUrl: null, stage: 'staging', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'username:password@example.com', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: null, upstreams: [], redirectTargetUrl: null, stage: 'local', basicAuthUsername: 'username', basicAuthPassword: 'password', accessRestriction: null, port: '443' },
  { descriptor: 'username:password@example.com -> http://target #staging', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: null, stage: 'staging', basicAuthUsername: 'username', basicAuthPassword: 'password', accessRestriction: null, port: '443' },
  { descriptor: '[1.2.3.4/24]username:password@example.com -> http://target #staging', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: null, stage: 'staging', basicAuthUsername: 'username', basicAuthPassword: 'password', accessRestriction: ['1.2.3.4/24'], port: '443' },
  { descriptor: ' [ 1.2.3.4 4.3.2.1/24 ] username:password@example.com -> http://target #staging', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target')], redirectTargetUrl: null, stage: 'staging', basicAuthUsername: 'username', basicAuthPassword: 'password', accessRestriction: ['1.2.3.4', '4.3.2.1/24'], port: '443' },
  { descriptor: 'example.com -> https://target1|target2:8000', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'https://', upstreams: [u('target1'), u('target2:8000')], redirectTargetUrl: null, stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
  { descriptor: 'example.com -> http://target1:8000|target2:8001[backup max_conns=100]', name: 'example.com', envFormatName: 'EXAMPLE_COM', upstreamProto: 'http://', upstreams: [u('target1:8000'), u('target2:8001', 'backup max_conns=100')], redirectTargetUrl: null, stage: 'local', basicAuthUsername: null, basicAuthPassword: null, accessRestriction: null, port: '443' },
];

describe('Domain — descriptor parsing parity with https-portal/spec/models/domain_spec.rb', () => {
  it.each(rows)('parses $descriptor', (row) => {
    const d = new Domain(row.descriptor, { defaultStage: 'local' });
    expect(d.name).toBe(row.name);
    expect(d.envFormatName).toBe(row.envFormatName);
    expect(d.upstreamProto).toBe(row.upstreamProto);
    expect(d.upstreams).toEqual(row.upstreams);
    expect(d.redirectTargetUrl).toBe(row.redirectTargetUrl);
    expect(d.stage).toBe(row.stage);
    expect(d.basicAuthUsername).toBe(row.basicAuthUsername);
    expect(d.basicAuthPassword).toBe(row.basicAuthPassword);
    expect(d.accessRestriction).toEqual(row.accessRestriction);
    expect(d.port).toBe(row.port);
  });
});

describe('Domain — derived behaviour', () => {
  it('upstream returns full URL with proto for -> mode', () => {
    const d = new Domain('example.com -> http://target:8080', { defaultStage: 'local' });
    expect(d.upstream).toBe('http://target:8080');
  });

  it('upstream is null for redirect mode', () => {
    const d = new Domain('example.com => http://target', { defaultStage: 'local' });
    expect(d.upstream).toBeNull();
  });

  it('upstream is null for static (no mode)', () => {
    const d = new Domain('example.com', { defaultStage: 'local' });
    expect(d.upstream).toBeNull();
  });

  it('multipleUpstreams reflects upstream count', () => {
    const single = new Domain('example.com -> http://a', { defaultStage: 'local' });
    const multi = new Domain('example.com -> http://a|b', { defaultStage: 'local' });
    expect(single.multipleUpstreams).toBe(false);
    expect(multi.multipleUpstreams).toBe(true);
  });

  it('basicAuthEnabled requires both user and pass', () => {
    const d = new Domain('user:pw@example.com', { defaultStage: 'local' });
    expect(d.basicAuthEnabled).toBe(true);
  });

  it('redirect-target with parameters throws', () => {
    const d = new Domain('example.com => target[backup]', { defaultStage: 'local' });
    expect(() => d.redirectTargetUrl).toThrow(/not supported on redirect-target/);
  });

  it('ca returns Let\'s Encrypt production URL', () => {
    const d = new Domain('example.com #production', { defaultStage: 'local' });
    expect(d.ca).toBe('https://acme-v02.api.letsencrypt.org/directory');
  });

  it('ca returns Let\'s Encrypt staging URL', () => {
    const d = new Domain('example.com #staging', { defaultStage: 'local' });
    expect(d.ca).toBe('https://acme-staging-v02.api.letsencrypt.org/directory');
  });

  it('ca is null for local stage', () => {
    const d = new Domain('example.com', { defaultStage: 'local' });
    expect(d.ca).toBeNull();
  });

  it('defaultStage is used when descriptor has no #stage suffix', () => {
    const d = new Domain('example.com', { defaultStage: 'production' });
    expect(d.stage).toBe('production');
  });

  it('per-domain stage overrides defaultStage', () => {
    const d = new Domain('example.com #staging', { defaultStage: 'production' });
    expect(d.stage).toBe('staging');
  });

  it('invalid stage value yields null', () => {
    const d = new Domain('example.com #nonsense', { defaultStage: 'local' });
    expect(d.stage).toBeNull();
  });

  it('wwwRoot is derived from the domain name', () => {
    const d = new Domain('example.com', { defaultStage: 'local' });
    expect(d.wwwRoot).toBe('/var/www/vhosts/example.com');
  });
});

describe('parseDomains', () => {
  it('splits comma-separated descriptors and skips empties', () => {
    const domains = parseDomains('a.com, b.com -> http://app , , c.com #staging', { defaultStage: 'local' });
    expect(domains.map((d) => d.name)).toEqual(['a.com', 'b.com', 'c.com']);
    expect(domains[1]!.upstream).toBe('http://app');
    expect(domains[2]!.stage).toBe('staging');
  });

  it('returns an empty array for empty input', () => {
    expect(parseDomains('', { defaultStage: 'local' })).toEqual([]);
    expect(parseDomains('   ', { defaultStage: 'local' })).toEqual([]);
  });
});

describe('InvalidDescriptorError', () => {
  it('throws on unparseable descriptor', () => {
    expect(() => new Domain('!!!@@@', { defaultStage: 'local' })).toThrow(InvalidDescriptorError);
  });
});
