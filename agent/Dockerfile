FROM --platform=$BUILDPLATFORM alpine:3 AS certs
RUN apk add --no-cache ca-certificates

FROM rust:1-alpine AS build
RUN apk add --no-cache build-base
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY agent ./agent
RUN cargo build --locked --release --bin uptarn-agent

FROM alpine:3 AS runtime
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV UPTARN_CONFIG=/etc/uptarn/agent.toml
ENTRYPOINT ["uptarn-agent"]
CMD ["daemon"]

FROM runtime AS prebuilt
ARG TARGETARCH
COPY --chmod=0755 dist/uptarn-agent-${TARGETARCH} /usr/local/bin/uptarn-agent

FROM runtime
COPY --from=build /src/target/release/uptarn-agent /usr/local/bin/uptarn-agent
