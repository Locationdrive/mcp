import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, SERVER_INSTRUCTIONS } from "../src/tools.js";
import { SERVER_NAME, VERSION } from "../src/version.js";

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
  if (req.method === "OPTIONS") return res.status(204).end();

  const auth = req.headers["authorization"] ?? "";
  const key = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Send your Location Drive API key as 'Authorization: Bearer ld_live_...'. Get one at https://locationdrive.com.",
    });
  }

  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, () => key);

  // Stateless mode: fresh transport per request, no session tracking.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
