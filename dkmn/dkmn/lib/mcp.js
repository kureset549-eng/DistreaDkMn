import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Single-user, in-memory registry (survives Next dev hot reloads via globalThis).
const S = (globalThis.__dkmn ||= { servers: new Map() });
const safe = (s) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

// 注意：传入的 servers 必须已经由 lib/mcpPolicy.js 的 parseMcpConfig 校验过
async function open(c) {
  if ("command" in c) {
    const client = new Client({ name: "dkmn", version: "1.0.0" });
    await client.connect(new StdioClientTransport({
      command: c.command, args: c.args || [],
      env: { ...getDefaultEnvironment(), ...(c.env || {}) },
    }));
    return client;
  }
  const url = new URL(c.url);
  const opts = { requestInit: { headers: c.headers || {}, redirect: "error" } };
  let last;
  // Try modern Streamable HTTP first, fall back to legacy SSE.
  for (const make of [() => new StreamableHTTPClientTransport(url, opts), () => new SSEClientTransport(url, opts)]) {
    const client = new Client({ name: "dkmn", version: "1.0.0" });
    try { await client.connect(make()); return client; } catch (e) { last = e; }
  }
  throw last;
}

export async function disconnectAll() {
  for (const s of S.servers.values()) await s.client?.close().catch(() => {});
  S.servers.clear();
}

export async function connectAll(servers) {
  await disconnectAll();
  await Promise.all(Object.entries(servers).map(async ([name, c]) => {
    try {
      const client = await open(c);
      const { tools } = await client.listTools();
      S.servers.set(name, { name, client, tools, status: "connected" });
    } catch (e) {
      S.servers.set(name, { name, tools: [], status: "error", error: String(e.message || e) });
    }
  }));
  return list();
}

export const list = () => [...S.servers.values()].map(({ name, tools, status, error }) => ({
  name, status, error, tools: tools.map((t) => ({ name: t.name, description: t.description })),
}));

export function toolDefs() {
  const defs = [];
  for (const s of S.servers.values())
    for (const t of s.tools)
      defs.push({ name: `${safe(s.name)}__${t.name}`.slice(0, 64), description: t.description || "",
        parameters: t.inputSchema, server: s.name, tool: t.name });
  return defs;
}

export async function callTool(def, args) {
  const r = await S.servers.get(def.server).client.callTool({ name: def.tool, arguments: args });
  const text = (r.content || []).map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
  return { text, isError: !!r.isError };
}
