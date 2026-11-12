import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal"]);

// 内网 / 保留地址段（IPv4）
const PRIVATE = new net.BlockList();
[
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
].forEach(([addr, prefix]) => PRIVATE.addSubnet(addr, prefix, "ipv4"));
// IPv6：未指定地址、回环、唯一本地 fc00::/7、链路本地 fe80::/10、组播
[["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]
  .forEach(([addr, prefix]) => PRIVATE.addSubnet(addr, prefix, "ipv6"));

export function isPrivateIp(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const fam = net.isIP(ip);
  if (!fam) return true; // 无法识别的地址一律视为不安全
  return PRIVATE.check(ip, fam === 6 ? "ipv6" : "ipv4");
}

// Google Safe Browsing：配置了 GOOGLE_SAFE_BROWSING_KEY 才检查；服务不可用时拒绝（fail-closed）
async function safeBrowsing(url) {
  const key = process.env.GOOGLE_SAFE_BROWSING_KEY;
  if (!key) return;
  const res = await fetch(
    `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "dkmn", clientVersion: "1.0.0" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: [{ url }],
        },
      }),
    }
  );
  if (!res.ok) throw new Error("安全检测服务暂不可用，已拒绝该地址");
  const j = await res.json();
  if (j.matches?.length) throw new Error("该地址被 Google Safe Browsing 标记为恶意或钓鱼网址，已拦截");
}

// 连接远程 MCP 前的 SSRF / 钓鱼检测
export async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`非法 URL：${raw}`); }
  if (u.protocol !== "https:") throw new Error("仅允许 https:// 协议的远程 MCP 地址");
  if (u.username || u.password) throw new Error("URL 不允许包含用户名或密码");

  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".internal"))
    throw new Error(`禁止访问的主机：${host}`);

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`禁止访问内网地址：${host}`);
  } else {
    // 检查真实解析出的所有 IP，防止域名指向内网（SSRF）
    const addrs = await dns.lookup(host, { all: true, verbatim: true }).catch(() => {
      throw new Error(`无法解析域名：${host}`);
    });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
      throw new Error(`域名 ${host} 解析到内网地址，已拦截`);
  }

  await safeBrowsing(u.href);
  return u;
}
