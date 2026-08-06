FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/persistence/package.json packages/persistence/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S pendleton && adduser -S pendleton -G pendleton
COPY --from=build --chown=pendleton:pendleton /app /app
USER pendleton
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
