import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Config } from './config.js';
import { renderCaddyfile } from './caddy.js';
import { ensureWelcomePage } from './welcome.js';
import { reportCompatibilityIssues } from './compatibility.js';
import { migrateLegacyCerts } from './migration.js';

const CADDYFILE_PATH = process.env.CADDYFILE_PATH ?? '/etc/caddy/Caddyfile';
const DOCKER_SOCKET_PATH = '/var/run/docker.sock';
const DOMAINS_FILE_PATH = '/var/run/domains';
const DYNAMIC_ENV_DIR = '/var/lib/https-portal/dynamic-env';
const DOMAINS_TEMPLATE_PATH = '/etc/docker-gen/domains.tmpl';
const RELOAD_DEBOUNCE_MS = 1000;

/**
 * Long-running supervisor. Renders the initial Caddyfile, spawns Caddy (and
 * optionally docker-gen), then watches `/var/run/domains` and the dynamic-env
 * directory for changes. On any change, re-renders the Caddyfile and asks
 * Caddy to atomically reload.
 *
 * Exits when Caddy exits. Forwards SIGTERM / SIGINT to Caddy for clean shutdown.
 */
export async function supervise(): Promise<number> {
  reportCompatibilityIssues();

  // Initial render
  const initialConfig = buildConfig();
  migrateLegacyCerts({ portalBaseDir: initialConfig.portalBaseDir });
  renderAndWrite(initialConfig);

  // Spawn long-running children
  const caddy = spawnCaddy();
  const dockerGen = existsSync(DOCKER_SOCKET_PATH) ? spawnDockerGen() : undefined;

  if (dockerGen) {
    console.log('[caddy-portal] docker-gen running (Docker socket detected, auto-discovery enabled)');
  } else {
    console.log('[caddy-portal] no Docker socket mounted; auto-discovery disabled');
  }

  // Wire reload triggers
  const triggerReload = debounce(() => reload(), RELOAD_DEBOUNCE_MS);
  watchPathIfExists(DOMAINS_FILE_PATH, triggerReload);
  watchPathIfExists(dirname(DOMAINS_FILE_PATH), triggerReload, DOMAINS_FILE_PATH);
  ensureDir(DYNAMIC_ENV_DIR);
  watchPathIfExists(DYNAMIC_ENV_DIR, triggerReload);

  // Forward shutdown signals to Caddy
  const forwardSignal = (sig: NodeJS.Signals) => {
    console.log(`[caddy-portal] received ${sig}, shutting down...`);
    caddy.kill(sig);
    dockerGen?.kill(sig);
  };
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  process.on('SIGINT', () => forwardSignal('SIGINT'));

  // We exit when Caddy exits.
  const exitCode: number = await new Promise((resolve) => {
    caddy.on('exit', (code) => resolve(code ?? 1));
  });

  if (dockerGen && dockerGen.exitCode === null) dockerGen.kill();
  return exitCode;
}

function buildConfig(): Config {
  return new Config(mergedEnv());
}

/**
 * Merge process.env with overlay files in DYNAMIC_ENV_DIR. The original
 * https-portal uses inotify + s6-envdir to do this; we do it in Node space.
 */
function mergedEnv(): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  if (!existsSync(DYNAMIC_ENV_DIR)) return merged;
  for (const entry of readdirSync(DYNAMIC_ENV_DIR)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(entry)) continue;
    try {
      merged[entry] = readFileSync(join(DYNAMIC_ENV_DIR, entry), 'utf8').trimEnd();
    } catch {
      // ignore unreadable files; partial writes will be picked up on next event
    }
  }
  return merged;
}

function renderAndWrite(config: Config): void {
  for (const domain of config.domains) ensureWelcomePage(domain);
  const caddyfile = renderCaddyfile(config);
  mkdirSync(dirname(CADDYFILE_PATH), { recursive: true });
  writeFileSync(CADDYFILE_PATH, caddyfile, 'utf8');
  console.log(
    `[caddy-portal] rendered Caddyfile: ${config.domains.length} domain(s), stage=${config.stage}`,
  );
}

function spawnCaddy(): ChildProcess {
  return spawn('caddy', ['run', '--config', CADDYFILE_PATH, '--adapter', 'caddyfile'], {
    stdio: 'inherit',
  });
}

function spawnDockerGen(): ChildProcess {
  return spawn(
    'docker-gen',
    [
      '-watch',
      '-only-exposed',
      '-notify-output',
      DOMAINS_TEMPLATE_PATH,
      DOMAINS_FILE_PATH,
    ],
    { stdio: 'inherit' },
  );
}

function reload(): void {
  const config = buildConfig();
  try {
    renderAndWrite(config);
  } catch (err) {
    console.error('[caddy-portal] render failed during reload:', err);
    return;
  }

  const result = spawnSync('caddy', ['reload', '--config', CADDYFILE_PATH, '--adapter', 'caddyfile'], {
    stdio: 'inherit',
  });
  if (result.status === 0) {
    console.log('[caddy-portal] reloaded');
  } else {
    console.error(`[caddy-portal] caddy reload failed (exit ${result.status})`);
  }
}

function watchPathIfExists(path: string, onChange: () => void, only?: string): void {
  if (!existsSync(path)) return;
  try {
    watch(path, (_evt, filename) => {
      if (only !== undefined && typeof filename === 'string') {
        const fullPath = join(path, filename);
        if (fullPath !== only) return;
      }
      onChange();
    });
  } catch (err) {
    console.warn(`[caddy-portal] could not watch ${path}:`, err);
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}

// Entry point when invoked as a script
if (import.meta.url === `file://${process.argv[1]}`) {
  supervise().then(
    (code) => process.exit(code),
    (err) => {
      console.error('[caddy-portal] supervisor crashed:', err);
      process.exit(1);
    },
  );
}
