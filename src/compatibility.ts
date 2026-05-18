/**
 * Detect env vars that won't carry over from https-portal and print actionable
 * warnings at startup. Called once from the CLI entry point.
 *
 * Two severity buckets:
 *   - HARD: the user's intent depends on nginx-specific behaviour we cannot
 *           replicate. The container still starts, but visible logging.
 *   - SOFT: harmless no-ops in Caddy world. Logged once at INFO-ish level so
 *           the user knows they can drop the setting.
 */
export function reportCompatibilityIssues(
  env: NodeJS.ProcessEnv = process.env,
  logger: { warn: (msg: string) => void; info: (msg: string) => void } = console,
): { hard: string[]; soft: string[] } {
  const hard: string[] = [];
  const soft: string[] = [];

  for (const key of Object.keys(env)) {
    if (HARD_KEYS.has(key) || HARD_KEY_PATTERNS.some((re) => re.test(key))) {
      hard.push(key);
      continue;
    }
    if (SOFT_KEYS.has(key)) {
      soft.push(key);
    }
  }

  for (const key of hard) {
    logger.warn(
      `[caddy-portal] ${key} has no Caddy equivalent and will be ignored. ` +
        `If you need this behaviour, stay with steveltn/https-portal or write a ` +
        `CUSTOM_CADDY_* override block by hand.`,
    );
  }

  for (const key of soft) {
    logger.info(
      `[caddy-portal] ${key} is a no-op in Caddy (${SOFT_REASONS[key]}). You can remove it from your env.`,
    );
  }

  return { hard, soft };
}

const HARD_KEYS = new Set<string>([
  'CUSTOM_NGINX_GLOBAL_HTTP_CONFIG_BLOCK',
  'CUSTOM_NGINX_SERVER_CONFIG_BLOCK',
  'CUSTOM_NGINX_SERVER_PLAIN_CONFIG_BLOCK',
  'ACME_CHALLENGE_BLOCK',
  'DEFAULT_SERVER_BLOCK',
]);

/** Matches any per-domain CUSTOM_NGINX_<DOMAIN>_CONFIG_BLOCK. */
const HARD_KEY_PATTERNS: RegExp[] = [/^CUSTOM_NGINX_.*_CONFIG_BLOCK$/];

const SOFT_REASONS: Record<string, string> = {
  WORKER_PROCESSES: 'Caddy is goroutine-based; no per-worker tuning',
  WORKER_CONNECTIONS: 'Caddy is goroutine-based',
  PROXY_BUFFERS: 'no equivalent — Caddy buffers internally',
  PROXY_BUFFER_SIZE: 'no equivalent — Caddy buffers internally',
  SERVER_NAMES_HASH_MAX_SIZE: 'concept does not exist in Caddy',
  SERVER_NAMES_HASH_BUCKET_SIZE: 'concept does not exist in Caddy',
  SERVER_TOKENS: 'Caddy hides server version by default',
  WEBSOCKET: 'Caddy reverse_proxy handles websocket upgrades automatically',
  LISTEN_IPV6: 'Caddy listens on IPv4 + IPv6 by default',
  DYNAMIC_UPSTREAM: 'different mechanism in Caddy (dynamic_upstreams)',
  RESOLVER: 'Caddy uses Go stdlib DNS resolution; configure DNS at the OS level',
  ACCESS_LOG_INCLUDE_HOST: 'host is always present in Caddy JSON logs',
  ACCESS_LOG_BUFFER: 'Caddy file output buffering is configured differently',
};

const SOFT_KEYS = new Set<string>(Object.keys(SOFT_REASONS));
