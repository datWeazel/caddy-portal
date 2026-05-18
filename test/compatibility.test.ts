import { describe, it, expect, vi } from 'vitest';
import { reportCompatibilityIssues } from '../src/compatibility.js';

function makeLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
  };
}

describe('reportCompatibilityIssues', () => {
  it('flags CUSTOM_NGINX_* env vars as hard issues', () => {
    const logger = makeLogger();
    const result = reportCompatibilityIssues(
      { CUSTOM_NGINX_GLOBAL_HTTP_CONFIG_BLOCK: 'foo' },
      logger,
    );
    expect(result.hard).toContain('CUSTOM_NGINX_GLOBAL_HTTP_CONFIG_BLOCK');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('flags CUSTOM_NGINX_EXAMPLE_COM_CONFIG_BLOCK via pattern match', () => {
    const logger = makeLogger();
    const result = reportCompatibilityIssues(
      { CUSTOM_NGINX_EXAMPLE_COM_CONFIG_BLOCK: 'foo' },
      logger,
    );
    expect(result.hard).toContain('CUSTOM_NGINX_EXAMPLE_COM_CONFIG_BLOCK');
  });

  it('flags WORKER_PROCESSES as a soft no-op', () => {
    const logger = makeLogger();
    const result = reportCompatibilityIssues({ WORKER_PROCESSES: '4' }, logger);
    expect(result.soft).toContain('WORKER_PROCESSES');
    expect(result.hard).toEqual([]);
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('flags SERVER_NAMES_HASH_MAX_SIZE as a soft no-op', () => {
    const logger = makeLogger();
    const result = reportCompatibilityIssues({ SERVER_NAMES_HASH_MAX_SIZE: '512' }, logger);
    expect(result.soft).toContain('SERVER_NAMES_HASH_MAX_SIZE');
  });

  it('says nothing for well-supported env vars', () => {
    const logger = makeLogger();
    const result = reportCompatibilityIssues(
      { DOMAINS: 'a.com', STAGE: 'staging', HSTS_MAX_AGE: '31536000' },
      logger,
    );
    expect(result.hard).toEqual([]);
    expect(result.soft).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
