# ── Backend Kardex (API + Socket.io + worker de reportes) ──
FROM node:20-bookworm-slim AS base
# OpenSSL: lo requiere el motor de Prisma
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS dependencias
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate

FROM base AS produccion
ENV NODE_ENV=production
COPY --from=dependencias /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
# Carpeta de exportaciones (monte un volumen aquí en Dokploy)
RUN mkdir -p /app/storage/reportes && chown -R node:node /app/storage
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/arranque.js"]
