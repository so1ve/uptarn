{ inputs, pkgs, ... }:

{
  overlays = [ inputs.js-toolchain-overlay.overlays.default ];

  languages = {
    javascript = {
      enable = true;
      package = pkgs.node-bin.fromProject ./.;
      pnpm.enable = true;
      lsp.package = pkgs.vtsls;
    };

    rust = {
      enable = true;
      toolchainFile = ./rust-toolchain.toml;
    };
  };

  packages = with pkgs; [
    actionlint
    git
    just
    nixfmt-tree
    prettierd
    tombi
    vscode-langservers-extracted
  ];

  enterShell = ''
    export PATH="$PWD/target/debug:$PATH"
  '';
}
