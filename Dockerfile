# ---- build stage ----
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production deps only
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/build ./build
COPY update_specs.py ./

# api/ is a persistent volume mount point — pre-create so ownership is correct
RUN mkdir -p /app/api

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/index.js"]
