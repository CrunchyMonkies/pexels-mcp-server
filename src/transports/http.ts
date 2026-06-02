import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { PexelsService } from "../services/pexels-service.js";
import { createServer as createMcpServer } from "../server.js";

/**
 * Starts the MCP server over the Streamable HTTP transport.
 *
 * Implements session management: an `initialize` request creates a new
 * transport + MCP server and returns an `mcp-session-id`; subsequent requests
 * reuse the transport identified by that header. Runs on `node:http`, which Bun
 * supports natively.
 */
export function startHttpServer(pexels: PexelsService, port: number): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req, res) => {
    if (!req.url || new URL(req.url, "http://localhost").pathname !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        let transport = sessionId ? transports.get(sessionId) : undefined;

        if (!transport && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => transports.set(id, transport!),
          });
          transport.onclose = () => {
            if (transport!.sessionId) transports.delete(transport!.sessionId);
          };
          // HTTP is remote: disable download tools and file output.
          const mcp = createMcpServer(pexels, { localMode: false });
          await mcp.connect(transport);
        }

        if (!transport) {
          res
            .writeHead(400, { "Content-Type": "application/json" })
            .end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "No valid session. Send an initialize request first." },
                id: null,
              }),
            );
          return;
        }

        await transport.handleRequest(req, res, body);
        return;
      }

      // GET (SSE stream) and DELETE (session teardown) reuse an existing session.
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(400).end("Invalid or missing session ID");
        return;
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
            id: null,
          }),
        );
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`Pexels MCP server (Streamable HTTP) listening on http://localhost:${port}/mcp`);
  });
}

/** Read and JSON-parse a request body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}
