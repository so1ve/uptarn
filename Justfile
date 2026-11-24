default:
    @just --list

dev:
    pnpm run dev

dev-web:
    pnpm run dev:web

build:
    pnpm run build
    cargo build --workspace --locked

check: check-ts check-rust check-nix

check-ts:
    pnpm run types:cloudflare
    pnpm run check

check-rust:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cargo test --workspace --locked

check-nix:
    actionlint
    nix fmt --accept-flake-config -- --ci
    nix flake check --all-systems --accept-flake-config

fmt:
    pnpm run lint:fix
    cargo fmt --all
    nix fmt --accept-flake-config

deploy:
    pnpm run deploy

release *args:
    pnpm run release {{ args }}
