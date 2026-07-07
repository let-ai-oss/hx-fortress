# TODO(prod): pin the base image by digest — oven/bun:1.3.14@sha256:<digest> —
# so a moved tag can't swap the toolchain under a rebuild (supply-chain, M-11).
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build            # produces ./dist/hx-fortress (compiled)

# TODO(prod): pin the base image by digest — oven/bun:1.3.14-slim@sha256:<digest>.
FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY --from=build /app/dist/hx-fortress /usr/local/bin/hx-fortress

# Run as a non-root system user (M-11). Two reasons: the embedded Postgres
# refuses to run as uid 0 (initdb/postgres abort as root), and dropping root
# shrinks the blast radius of any RCE in a downloaded/loaded artifact. /data is
# the writable state volume, owned by the fortress user.
RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin fortress \
  && mkdir -p /data \
  && chown -R fortress:fortress /data

# Persist config.json / credentials.json / signing-key on a mounted volume.
# NOTE: a bind-mounted /data keeps the host's ownership — mount it writable by
# uid 10001 (or use a named volume, which inherits the image's ownership).
ENV FORTRESS_ROOT=/data
VOLUME ["/data"]
EXPOSE 8787
USER fortress
# FORTRESS_PUBLIC_URL + storage config supplied at runtime (-e / compose).
# TLS terminates at the customer ingress in front of this container.
ENTRYPOINT ["hx-fortress", "host"]
