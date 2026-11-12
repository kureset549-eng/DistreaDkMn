import { connectAll, list } from "@/lib/mcp";
import { requireAuth } from "@/lib/auth";
import { parseMcpConfig } from "@/lib/mcpPolicy";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024; // 整个请求体上限，配置本身的 15KB 在 parseMcpConfig 里检查

export async function GET(req) {
  const denied = requireAuth(req); if (denied) return denied;
  return Response.json({ servers: list() });
}

export async function POST(req) {
  const denied = requireAuth(req); if (denied) return denied;

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY)
    return Response.json({ error: "请求体过大" }, { status: 413 });

  let body;
  try { body = JSON.parse(text); } catch { return Response.json({ error: "请求格式错误" }, { status: 400 }); }

  try {
    const servers = await parseMcpConfig(body.config);
    return Response.json({ servers: await connectAll(servers) });
  } catch (e) {
    return Response.json({ error: e.message }, { status: e.status || 400 });
  }
}
