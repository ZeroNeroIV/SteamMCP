FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER bun
EXPOSE 8080
CMD ["bun", "src/cli.ts", "http"]
