FROM node:24-slim

# ffmpeg splits recordings longer than ~25 minutes for transcription.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY scripts ./scripts

ENV HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=8s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/ping').then(r=>r.json()).then(h=>process.exit(h.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
