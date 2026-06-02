#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PexelsService } from "./services/pexels-service.js";
import { createServer } from "./server.js";
import { startHttpServer } from "./transports/http.js";

/**
 * Entry point. Selects the MCP transport via the `MCP_TRANSPORT` env var:
 *   - "stdio" (default): communicate over stdin/stdout.
 *   - "http": serve the Streamable HTTP transport on `PORT` (default 3000).
 *
 * The Pexels API key comes from `PEXELS_API_KEY` (or the runtime `setApiKey` tool).
 */
async function main(): Promise<void> {
  const pexels = new PexelsService();
  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

  if (transport === "http") {
    const port = parseInt(process.env.PORT ?? "3000", 10);
    startHttpServer(pexels, port);
    return;
  }

  const server = createServer(pexels, { localMode: true });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("Fatal error starting Pexels MCP server:", err);
  process.exit(1);
});
