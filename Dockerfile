# UPGS Perf – run with Docker (Node 22 + Chromium for Lighthouse/screenshots)
FROM node:22-bookworm-slim

# Chromium for Lighthouse and full-page screenshots
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Install dependencies (reproducible with lockfile)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code
COPY . .

# Persistent data: DB, sessions, screenshots, filmstrips
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

ENV PORT=3000
# Default DB under /app/data so one volume can persist everything
ENV DB_PATH=/app/data/upgs.db

CMD ["node", "src/index.js"]
