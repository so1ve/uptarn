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
      serverManifest = builtins.fromJSON (builtins.readFile ./server/package.json);
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
            root = ./server;
            fileset = pkgs.lib.fileset.unions [
              ./server/package.json
              ./server/pnpm-lock.yaml
              ./server/pnpm-workspace.yaml
              ./server/vite.config.ts
              ./server/src/shared
              ./server/web
            ];
          };
        in
        pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
          pname = "uptarn-web";
          inherit (serverManifest) version;
          inherit src;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            fetcherVersion = 5;
            hash = "sha256-Y6fz5DPi7Kg6hBlr9Y27gblCAiwLpzVm7xSLBSnW50o=";
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
            cp -r public "$out"
            runHook postInstall
          '';
        });

      mkServerPackage =
        pkgs:
        let
          webAssets = mkWebAssets pkgs;
          src = pkgs.lib.fileset.toSource {
            root = ./server;
            fileset = pkgs.lib.fileset.unions [
              ./server/package.json
              ./server/pnpm-lock.yaml
              ./server/pnpm-workspace.yaml
              ./server/migrations
              ./server/src
            ];
          };
        in
        pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
          pname = "uptarn-server";
          inherit (serverManifest) version;
          inherit src;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            fetcherVersion = 5;
            pnpmInstallFlags = [ "--prod" ];
            hash = "sha256-RVXBgEsTp496gqmCh/Q3w54jIlQ4LFEKrLD8GR1Zch4=";
          };

          pnpmInstallFlags = [ "--prod" ];

          nativeBuildInputs = [
            pkgs.makeWrapper
            pkgs.nodejs_24
            pkgs.pnpm
            pkgs.pnpmConfigHook
          ];

          installPhase = ''
            runHook preInstall

            mkdir -p "$out/bin" "$out/share/uptarn-server"
            cp -r package.json src migrations node_modules "$out/share/uptarn-server"
            cp -r ${webAssets} "$out/share/uptarn-server/public"

            makeWrapper ${pkgs.lib.getExe pkgs.nodejs_24} "$out/bin/uptarn-server" \
              --add-flags "$out/share/uptarn-server/src/node.ts"

            runHook postInstall
          '';

          meta = {
            inherit (serverManifest) description;
            homepage = "https://github.com/so1ve/uptarn";
            license = pkgs.lib.licenses.mit;
            mainProgram = "uptarn-server";
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
          uptarn-server = mkServerPackage pkgs;
          isLinux = pkgs.stdenv.hostPlatform.isLinux;
        in
        {
          inherit uptarn-server;
          default = if isLinux then mkAgentPackage pkgs else uptarn-server;
        }
        // pkgs.lib.optionalAttrs isLinux {
          uptarn-agent = mkAgentPackage pkgs;
          uptarn-agent-static = mkAgentPackage pkgs.pkgsStatic;
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      overlays.default =
        final: _prev:
        {
          uptarn-server = mkServerPackage final;
        }
        // final.lib.optionalAttrs final.stdenv.hostPlatform.isLinux {
          uptarn-agent = mkAgentPackage final;
        };

      nixosModules = {
        hub =
          { lib, pkgs, ... }:
          {
            imports = [ ./nix/hub-module.nix ];
            services.uptarn.package =
              lib.mkDefault
                self.packages.${pkgs.stdenv.hostPlatform.system}.uptarn-server;
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
