# Image Render : Node 20 + FFmpeg du système (drawtext, loudnorm, libx264 inclus).
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "index.js"]
