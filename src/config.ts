export interface ServerRuntimeEnv {
  PUBLIC_BASE_URL?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_PASSWORD_SHA256?: string;
  ADMIN_TOKEN?: string;
  ENROLLMENT_TOKEN?: string;
  AUTO_REGISTER?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  MATRIX_HOMESERVER?: string;
  MATRIX_ACCESS_TOKEN?: string;
  MATRIX_ROOM_ID?: string;
  RETENTION_DAYS?: string;
  FAILURE_THRESHOLD?: string;
}

export interface CfAccessConfig {
  teamDomain: string;
  aud: string;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface MatrixConfig {
  homeserver: string;
  accessToken: string;
  roomId: string;
}

export interface LoadedConfig {
  publicBaseUrl: string;
  adminPassword: string | null;
  adminPasswordSha256: string | null;
  adminToken: string | null;
  enrollmentToken: string | null;
  defaultAutoRegister: boolean;
  cfAccess: CfAccessConfig | null;
  telegram: TelegramConfig | null;
  matrix: MatrixConfig | null;
  retentionDays: number;
  failureThreshold: number;
}

const envStr = (value: string | undefined): string | null =>
  value?.trim() || null;

function envInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(envStr(value) ?? "", 10);

  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

const envBool = (value: string | undefined): boolean =>
  ["1", "true", "yes"].includes(envStr(value)?.toLowerCase() ?? "");

export function loadConfig(env: ServerRuntimeEnv): LoadedConfig {
  const publicBaseUrl = (
    envStr(env.PUBLIC_BASE_URL) ?? "http://localhost:8787"
  ).replace(/\/+$/, "");

  const cfTeam = envStr(env.CF_ACCESS_TEAM_DOMAIN)
    ?.replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const cfAud = envStr(env.CF_ACCESS_AUD);

  const tgToken = envStr(env.TELEGRAM_BOT_TOKEN);
  const tgChat = envStr(env.TELEGRAM_CHAT_ID);

  const mxServer = envStr(env.MATRIX_HOMESERVER)?.replace(/\/+$/, "");
  const mxToken = envStr(env.MATRIX_ACCESS_TOKEN);
  const mxRoom = envStr(env.MATRIX_ROOM_ID);

  return {
    publicBaseUrl,
    adminPassword: envStr(env.ADMIN_PASSWORD),
    adminPasswordSha256:
      envStr(env.ADMIN_PASSWORD_SHA256)?.toLowerCase() ?? null,
    adminToken: envStr(env.ADMIN_TOKEN),
    enrollmentToken: envStr(env.ENROLLMENT_TOKEN),
    defaultAutoRegister: envBool(env.AUTO_REGISTER),
    cfAccess: cfTeam && cfAud ? { teamDomain: cfTeam, aud: cfAud } : null,
    telegram: tgToken && tgChat ? { botToken: tgToken, chatId: tgChat } : null,
    matrix:
      mxServer && mxToken && mxRoom
        ? { homeserver: mxServer, accessToken: mxToken, roomId: mxRoom }
        : null,
    retentionDays: envInt(env.RETENTION_DAYS, 14, 1, 365),
    failureThreshold: envInt(env.FAILURE_THRESHOLD, 2, 1, 10),
  };
}
