# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json ./
RUN npm install

# Copy source and build
COPY . .

# API key is injected at build time via --build-arg
ARG VITE_ANTHROPIC_API_KEY
ENV VITE_ANTHROPIC_API_KEY=$VITE_ANTHROPIC_API_KEY

RUN npm run build

# ── Stage 2: Serve ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Only copy the built output and the preview script
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/vite.config.js ./vite.config.js

EXPOSE 4173

CMD ["npm", "run", "preview"]
