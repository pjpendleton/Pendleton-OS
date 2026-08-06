FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S pendleton && adduser -S pendleton -G pendleton
COPY --from=build --chown=pendleton:pendleton /app /app
USER pendleton
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
