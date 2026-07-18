# ---- deps + build ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src/rateLimiter/luaScripts ./dist/rateLimiter/luaScripts
COPY src/clients/clients.json ./dist/clients/clients.json
COPY src/db/migrations ./dist/db/migrations
COPY public ./public

EXPOSE 3000
CMD ["node", "dist/server.js"]
