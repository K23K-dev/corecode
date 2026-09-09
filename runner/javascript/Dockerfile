FROM node:22-bookworm-slim AS dependencies
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/runner
COPY runner/javascript/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
FROM dependencies
COPY runner/javascript/ ./
ENV HOME=/work TMPDIR=/work
USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/runner/entrypoint.mjs"]
