FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package*.json ./
RUN npm install

# Build the unified Vite frontend
FROM deps AS builder
COPY . .
RUN npm run vite:build

# Production runner — hosted-server serves dist/ plus the local-AI bridge
FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/hosted-server.js ./hosted-server.js
COPY --from=builder /app/package.json ./package.json

EXPOSE 8794
CMD ["node", "hosted-server.js"]
