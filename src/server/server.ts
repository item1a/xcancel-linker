import type { IncomingMessage, ServerResponse } from "node:http";

export async function serverOnRequest(
  _req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  rsp.writeHead(404, { "Content-Type": "application/json" });
  rsp.end(JSON.stringify({ error: "not found", status: 404 }));
}
