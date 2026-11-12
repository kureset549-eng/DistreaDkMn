// lib/mcp.js - 安全版，只保存配置，不在Render执行，执行放前端
const S = globalThis.__dkmn ||= { servers: new Map() };

export function list(){
  return Object.fromEntries(S.servers);
}

export async function connectAll(servers){
  // servers 已经由 parseMcpConfig 校验过
  S.servers = new Map(Object.entries(servers));
  return Object.keys(servers).map(name => ({
    name,
    status: "validated，前端执行"
  }));
}
