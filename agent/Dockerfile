FROM rust:1-alpine AS build
RUN apk add --no-cache build-base
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY agent ./agent
RUN cargo build --locked --release --bin uptarn-agent

FROM alpine:3
RUN apk add --no-cache ca-certificates
COPY --from=build /src/target/release/uptarn-agent /usr/local/bin/uptarn-agent
ENV UPTARN_CONFIG=/etc/uptarn/agent.toml
ENTRYPOINT ["uptarn-agent"]
CMD ["daemon"]
