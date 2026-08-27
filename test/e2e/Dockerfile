# Runs the REAL divine-realness worker inside the real Cloudflare Workers
# runtime (workerd, via Miniflare) and drives its queue() handler with
# byte-exact client tags captured from divine-web and divine-mobile.
FROM node:22-bookworm-slim

WORKDIR /e2e

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY vitest.config.mts tsconfig.json ./
COPY test ./test

# The worker source is bind-mounted read-only at /repo by docker-compose and
# copied in by the entrypoint, so the harness always exercises the real tree.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "test"]
