FROM oven/bun:1 AS base

WORKDIR /usr/src/app

# Install dependencies (cached layer)
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --production

# Copy source — Bun runs TypeScript directly, no build step required
COPY . .

# Default API key (overridden by Smithery / runtime config)
ENV PEXELS_API_KEY=""

# Default transport is stdio; set MCP_TRANSPORT=http and PORT to serve over HTTP
CMD ["bun", "src/main.ts"]
