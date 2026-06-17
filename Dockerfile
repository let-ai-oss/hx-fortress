FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build            # produces ./dist/hx-fortress (compiled)

FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY --from=build /app/dist/hx-fortress /usr/local/bin/hx-fortress
# Persist config.json / credentials.json / signing-key on a mounted volume.
ENV FORTRESS_ROOT=/data
VOLUME ["/data"]
EXPOSE 8787
# FORTRESS_PUBLIC_URL + storage config supplied at runtime (-e / compose).
# TLS terminates at the customer ingress in front of this container.
ENTRYPOINT ["hx-fortress", "host"]
