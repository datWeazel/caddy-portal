import { describe, it, expect } from 'vitest';
import { ensureWelcomePage, renderWelcomeHtml } from '../src/welcome.js';
import { Domain } from '../src/domain.js';

function makeFakeWriter() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    writer: {
      exists: (p: string) => files.has(p),
      mkdirp: (p: string) => {
        dirs.add(p);
      },
      write: (p: string, c: string) => {
        files.set(p, c);
      },
    },
  };
}

describe('ensureWelcomePage', () => {
  it('writes index.html for a static-only domain', () => {
    const { files, dirs, writer } = makeFakeWriter();
    const d = new Domain('example.com', { defaultStage: 'local' });
    ensureWelcomePage(d, { fileWriter: writer });
    expect(dirs.has('/var/www/vhosts/example.com')).toBe(true);
    expect(files.get('/var/www/vhosts/example.com/index.html')).toContain('Welcome to caddy-portal');
  });

  it('skips when domain has an upstream', () => {
    const { files, writer } = makeFakeWriter();
    const d = new Domain('example.com -> http://app', { defaultStage: 'local' });
    ensureWelcomePage(d, { fileWriter: writer });
    expect(files.size).toBe(0);
  });

  it('skips when domain has a redirect target', () => {
    const { files, writer } = makeFakeWriter();
    const d = new Domain('example.com => http://other', { defaultStage: 'local' });
    ensureWelcomePage(d, { fileWriter: writer });
    expect(files.size).toBe(0);
  });

  it('skips when index.html already exists', () => {
    const { files, writer } = makeFakeWriter();
    files.set('/var/www/vhosts/example.com/index.html', '<custom user content>');
    const d = new Domain('example.com', { defaultStage: 'local' });
    ensureWelcomePage(d, { fileWriter: writer });
    expect(files.get('/var/www/vhosts/example.com/index.html')).toBe('<custom user content>');
  });
});

describe('renderWelcomeHtml', () => {
  it('includes a production-stage message', () => {
    const d = new Domain('example.com #production', { defaultStage: 'local' });
    expect(renderWelcomeHtml(d)).toMatch(/Let.s Encrypt<\/a>\./);
  });

  it('includes a staging-stage message', () => {
    const d = new Domain('example.com #staging', { defaultStage: 'local' });
    expect(renderWelcomeHtml(d)).toContain('staging server');
  });

  it('includes a local-stage message', () => {
    const d = new Domain('example.com', { defaultStage: 'local' });
    expect(renderWelcomeHtml(d)).toContain('self-signed');
  });

  it('mentions the www_root path so the user knows where to mount content', () => {
    const d = new Domain('example.com', { defaultStage: 'local' });
    expect(renderWelcomeHtml(d)).toContain('/var/www/vhosts/example.com');
  });
});
