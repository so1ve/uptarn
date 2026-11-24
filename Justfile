default:
    @just --list

dev:
    pnpm --dir server run dev

dev-web:
    pnpm --dir server run dev:web

build:
    pnpm --dir server run build
    cargo build --workspace --locked

check: check-server check-rust check-nix

check-server:
    pnpm --dir server run types:cloudflare
    pnpm --dir server run check

check-rust:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cargo test --workspace --locked

check-nix:
    actionlint
    nix fmt --accept-flake-config -- --ci
    nix flake check --all-systems --accept-flake-config

fmt:
    pnpm --dir server run lint:fix
    cargo fmt --all
    nix fmt --accept-flake-config

deploy:
    pnpm --dir server run deploy

release *args:
    pnpm --dir server run release {{ args }}
