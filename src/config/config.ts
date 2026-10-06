/** Configuracao do servidor, com defaults do projeto e overrides por variaveis de ambiente. */
export interface MonitorConfig {
  defaultLimit: number;
  maxLimit: number;
  defaultWindowMs: number;
}

export interface IpaasConfig {
  frontUrl: string;
  apiBaseUrl: string;
  loginTimeoutMs: number;
  sessionTtlMs: number;
  monitor: MonitorConfig;
}

const HOUR_MS = 60 * 60 * 1000;

function num(envValue: string | undefined, fallback: number): number {
  const parsed = Number(envValue);
  return envValue !== undefined && Number.isFinite(parsed) ? parsed : fallback;
}

function str(envValue: string | undefined, fallback: string): string {
  return envValue && envValue.trim() !== "" ? envValue : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IpaasConfig {
  return {
    frontUrl: str(env.IPAAS_FRONT_URL, "https://ipaas.totvs.app"),
    apiBaseUrl: str(env.IPAAS_API_BASE_URL, "https://api-ipaas.totvs.app"),
    loginTimeoutMs: num(env.IPAAS_LOGIN_TIMEOUT_MS, 2 * 60 * 1000),
    sessionTtlMs: num(env.IPAAS_SESSION_TTL_MS, 48 * HOUR_MS),
    monitor: {
      defaultLimit: num(env.IPAAS_MONITOR_DEFAULT_LIMIT, 20),
      maxLimit: num(env.IPAAS_MONITOR_MAX_LIMIT, 100),
      defaultWindowMs: num(env.IPAAS_MONITOR_DEFAULT_WINDOW_MS, 24 * HOUR_MS),
    },
  };
}
