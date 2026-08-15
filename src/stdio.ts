#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, SERVER_INSTRUCTIONS } from "./tools.js";
import { SERVER_NAME, VERSION } from "./version.js";

const key = process.env.LOCATIONDRIVE_API_KEY;
if (!key) {
  console.error(
    "LOCATIONDRIVE_API_KEY is not set.\n" +
      "Create a key at https://locationdrive.com (Dashboard -> API Keys) and add it to your MCP config env.",
  );
  process.exit(1);
}

const server = new McpServer(
  { name: SERVER_NAME, version: VERSION },
  { instructions: SERVER_INSTRUCTIONS },
);
registerTools(server, () => key);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Location Drive MCP server v${VERSION} running (stdio)`);
