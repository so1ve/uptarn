{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.uptarn-agent;
  tomlFormat = pkgs.formats.toml { };

  credentials = lib.filter (s: s != "") [
    (lib.optionalString (cfg.tokenFile != null) "token:${cfg.tokenFile}")
    (lib.optionalString (cfg.enrollTokenFile != null) "enroll-token:${cfg.enrollTokenFile}")
  ];

  mergedSettings =
    cfg.settings
    // {
      hub_url = cfg.hubUrl;
    }
    // lib.optionalAttrs (cfg.nodeId != null) {
      node_id = cfg.nodeId;
    }
    // lib.optionalAttrs (cfg.tokenFile != null) {
      token_file = "/run/credentials/uptarn-agent.service/token";
    }
    // lib.optionalAttrs (cfg.enrollTokenFile != null) {
      enroll_token_file = "/run/credentials/uptarn-agent.service/enroll-token";
    };

  configFile = tomlFormat.generate "uptarn-agent.toml" mergedSettings;
in
{
  options.services.uptarn-agent = {
    enable = lib.mkEnableOption "Uptarn telemetry agent";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The uptarn-agent package to run.";
    };

    hubUrl = lib.mkOption {
      type = lib.types.str;
      example = "https://status.example.com";
      description = "Base URL of the Uptarn hub.";
    };

    nodeId = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = config.networking.hostName;
      description = "Unique node identifier (defaults to networking.hostName).";
    };

    tokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to file containing the node Bearer token.";
    };

    enrollTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional path to file containing the auto-registration enrollment token.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Extra packages added to PATH for [[checks]] and exec [[monitors]].";
    };

    settings = lib.mkOption {
      inherit (tomlFormat) type;
      default = { };
      description = "Additional agent.toml configuration (system, mounts, checks, check_dirs, info, monitors).";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.etc."uptarn/agent.toml".source = configFile;

    systemd.services.uptarn-agent = {
      description = "Uptarn telemetry agent";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];

      path = cfg.extraPackages;

      serviceConfig = {
        Type = "simple";
        DynamicUser = true;
        LoadCredential = credentials;
        ExecStart = "${lib.getExe cfg.package} daemon --config /etc/uptarn/agent.toml";
        Restart = "always";
        RestartSec = "5s";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = "read-only";
      };
    };
  };
}
