{
  description = "Push-based monitoring hub built for Cloudflare Workers, unifying flexible node reporting, HTTP probes, and cron jobs";

  nixConfig = {
    extra-substituters = [ "https://cache.so1ve.dev" ];
    extra-trusted-public-keys = [
      "cache.so1ve.dev-1:SijyzF9iE/VZwMXgMpd/HrNX9iItDZ1tdiNdeGakQGY="
    ];
  };

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      manifest = builtins.fromJSON (builtins.readFile ./package.json);
      cargoToml = builtins.fromTOML (builtins.readFile ./Cargo.toml);
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      mkWebAssets =
        pkgs:
        let
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./pnpm-lock.yaml
              ./pnpm-workspace.yaml
              ./vite.config.ts
              ./src/shared
              ./web
            ];
          };
        in
        pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
          pname = "uptarn-web";
          inherit (manifest) version;
          inherit src;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            fetcherVersion = 5;
            hash = "sha256-holfiF+fUD/UmmznqoWgp879n9dU3DNtcU3vdWHZ0jg=";
          };

          nativeBuildInputs = [
            pkgs.nodejs_24
            pkgs.pnpm
            pkgs.pnpmConfigHook
          ];

          buildPhase = ''
            runHook preBuild
            pnpm run build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            cp -r web/dist "$out"
            runHook postInstall
          '';
        });

      mkPackage =
        pkgs:
        let
          webAssets = mkWebAssets pkgs;
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./pnpm-lock.yaml
              ./pnpm-workspace.yaml
              ./migrations
              ./src
            ];
          };
        in
        pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
          pname = manifest.name;
          inherit (manifest) version;
          inherit src;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            fetcherVersion = 5;
            pnpmInstallFlags = [ "--prod" ];
            hash = "sha256-GuKKsdIkRfb9b3joaJ5ylhC28Pq5m6Oulmg0pwnCldA=";
          };

          pnpmInstallFlags = [ "--prod" ];

          nativeBuildInputs = [
            pkgs.installShellFiles
            pkgs.makeWrapper
            pkgs.nodejs_24
            pkgs.pnpm
            pkgs.pnpmConfigHook
          ];

          installPhase = ''
            runHook preInstall

            mkdir -p "$out/bin" "$out/share/uptarn/web"
            cp -r package.json src migrations node_modules "$out/share/uptarn"
            cp -r ${webAssets} "$out/share/uptarn/web/dist"

            makeWrapper ${pkgs.lib.getExe pkgs.nodejs_24} "$out/bin/uptarn" \
              --add-flags "$out/share/uptarn/src/cli/index.ts"

            installShellCompletion --cmd uptarn \
              --bash <("$out/bin/uptarn" completions bash) \
              --fish <("$out/bin/uptarn" completions fish) \
              --zsh <("$out/bin/uptarn" completions zsh)

            runHook postInstall
          '';

          meta = {
            inherit (manifest) description;
            homepage = "https://github.com/so1ve/uptarn";
            license = pkgs.lib.licenses.mit;
            mainProgram = manifest.name;
            platforms = pkgs.lib.platforms.unix;
          };
        });

      mkAgentPackage =
        pkgs:
        pkgs.rustPlatform.buildRustPackage {
          pname = "uptarn-agent";
          inherit (cargoToml.workspace.package) version;

          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./Cargo.lock
              ./Cargo.toml
              ./agent
            ];
          };

          cargoLock.lockFile = ./Cargo.lock;

          nativeBuildInputs = [ pkgs.installShellFiles ];

          postInstall = pkgs.lib.optionalString (pkgs.stdenv.buildPlatform.canExecute pkgs.stdenv.hostPlatform) ''
            installShellCompletion --cmd uptarn-agent \
              --bash <("$out/bin/uptarn-agent" completions bash) \
              --fish <("$out/bin/uptarn-agent" completions fish) \
              --zsh <("$out/bin/uptarn-agent" completions zsh)
          '';

          meta = {
            description = "Static Linux agent and cron job wrapper for Uptarn";
            homepage = "https://github.com/so1ve/uptarn";
            license = pkgs.lib.licenses.mit;
            mainProgram = "uptarn-agent";
            platforms = pkgs.lib.platforms.linux;
          };
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          uptarn = mkPackage pkgs;
          isLinux = pkgs.stdenv.hostPlatform.isLinux;
        in
        {
          inherit uptarn;
          default = uptarn;
        }
        // pkgs.lib.optionalAttrs isLinux {
          uptarn-agent = mkAgentPackage pkgs;
          uptarn-agent-static = mkAgentPackage pkgs.pkgsStatic;
        }
      );

      apps = forAllSystems (
        system:
        let
          uptarnApp = {
            type = "app";
            program = nixpkgs.lib.getExe self.packages.${system}.uptarn;
            meta.description = manifest.description;
          };
        in
        {
          uptarn = uptarnApp;
          default = uptarnApp;
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      overlays.default =
        final: _prev:
        {
          uptarn = mkPackage final;
        }
        // final.lib.optionalAttrs final.stdenv.hostPlatform.isLinux {
          uptarn-agent = mkAgentPackage final;
        };

      nixosModules = {
        hub =
          { lib, pkgs, ... }:
          {
            imports = [ ./nix/hub-module.nix ];
            services.uptarn.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.uptarn;
          };

        agent =
          { lib, pkgs, ... }:
          {
            imports = [ ./nix/agent-module.nix ];
            services.uptarn-agent.package =
              lib.mkDefault
                self.packages.${pkgs.stdenv.hostPlatform.system}.uptarn-agent;
          };

        default = {
          imports = [
            self.nixosModules.hub
            self.nixosModules.agent
          ];
        };
      };
    };
}
