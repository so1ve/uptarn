{
  config,
  lib,
  ...
}:

let
  cfg = config.services.uptarn;

  credentials = lib.filter (s: s != "") [
    (lib.optionalString (cfg.adminPasswordFile != null) "admin-password:${cfg.adminPasswordFile}")
    (lib.optionalString (cfg.adminTokenFile != null) "admin-token:${cfg.adminTokenFile}")
    (lib.optionalString (cfg.enrollmentTokenFile != null) "enrollment-token:${cfg.enrollmentTokenFile}")
    (lib.optionalString (cfg.cfAccessAudFile != null) "cf-access-aud:${cfg.cfAccessAudFile}")
    (lib.optionalString (
      cfg.telegramBotTokenFile != null
    ) "telegram-bot-token:${cfg.telegramBotTokenFile}")
    (lib.optionalString (
      cfg.matrixAccessTokenFile != null
    ) "matrix-access-token:${cfg.matrixAccessTokenFile}")
  ];
in
{
  options.services.uptarn = {
    enable = lib.mkEnableOption "Uptarn monitoring hub";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The Uptarn server package to run.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address to bind the HTTP server to.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8787;
      description = "Port to bind the HTTP server to.";
    };

    publicBaseUrl = lib.mkOption {
      type = lib.types.str;
      example = "https://status.example.com";
      description = "Public HTTPS base URL of the Uptarn hub.";
    };

    retentionDays = lib.mkOption {
      type = lib.types.ints.positive;
      default = 14;
      description = "Days to retain alert event history.";
    };

    failureThreshold = lib.mkOption {
      type = lib.types.ints.positive;
      default = 2;
      description = "Consecutive failures before opening an incident.";
    };

    tickIntervalSecs = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 60;
      description = "Scheduler tick interval in seconds (0 disables in-process scheduler).";
    };

    adminPasswordFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional file containing ADMIN_PASSWORD.";
    };

    adminTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional file containing ADMIN_TOKEN.";
    };

    enrollmentTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional file containing ENROLLMENT_TOKEN.";
    };

    cfAccessTeamDomain = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional Cloudflare Access team domain.";
    };

    cfAccessAudFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional file containing Cloudflare Access Application Audience (AUD) tag.";
    };

    telegramChatId = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional Telegram target chat ID.";
    };

    telegramBotTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional file containing TELEGRAM_BOT_TOKEN.";
    };

    matrixHomeserver = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional Matrix homeserver base URL.";
    };

    matrixRoomId = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional Matrix room ID for alerts.";
    };

    matrixAccessTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional file containing MATRIX_ACCESS_TOKEN.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional systemd EnvironmentFile.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.uptarn = {
      description = "Uptarn monitoring hub";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];

      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        PUBLIC_BASE_URL = cfg.publicBaseUrl;
        RETENTION_DAYS = toString cfg.retentionDays;
        FAILURE_THRESHOLD = toString cfg.failureThreshold;
        TICK_INTERVAL_SECS = toString cfg.tickIntervalSecs;
        UPTARN_DB_PATH = "/var/lib/uptarn/uptarn.db";
      }
      // lib.optionalAttrs (cfg.adminPasswordFile != null) {
        ADMIN_PASSWORD_FILE = "/run/credentials/uptarn.service/admin-password";
      }
      // lib.optionalAttrs (cfg.adminTokenFile != null) {
        ADMIN_TOKEN_FILE = "/run/credentials/uptarn.service/admin-token";
      }
      // lib.optionalAttrs (cfg.enrollmentTokenFile != null) {
        ENROLLMENT_TOKEN_FILE = "/run/credentials/uptarn.service/enrollment-token";
      }
      // lib.optionalAttrs (cfg.cfAccessTeamDomain != null) {
        CF_ACCESS_TEAM_DOMAIN = cfg.cfAccessTeamDomain;
      }
      // lib.optionalAttrs (cfg.cfAccessAudFile != null) {
        CF_ACCESS_AUD_FILE = "/run/credentials/uptarn.service/cf-access-aud";
      }
      // lib.optionalAttrs (cfg.telegramChatId != null) {
        TELEGRAM_CHAT_ID = cfg.telegramChatId;
      }
      // lib.optionalAttrs (cfg.telegramBotTokenFile != null) {
        TELEGRAM_BOT_TOKEN_FILE = "/run/credentials/uptarn.service/telegram-bot-token";
      }
      // lib.optionalAttrs (cfg.matrixHomeserver != null) {
        MATRIX_HOMESERVER = cfg.matrixHomeserver;
      }
      // lib.optionalAttrs (cfg.matrixRoomId != null) {
        MATRIX_ROOM_ID = cfg.matrixRoomId;
      }
      // lib.optionalAttrs (cfg.matrixAccessTokenFile != null) {
        MATRIX_ACCESS_TOKEN_FILE = "/run/credentials/uptarn.service/matrix-access-token";
      };

      serviceConfig = {
        Type = "simple";
        DynamicUser = true;
        StateDirectory = "uptarn";
        LoadCredential = credentials;
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = "5s";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
      }
      // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
    };
  };
}
