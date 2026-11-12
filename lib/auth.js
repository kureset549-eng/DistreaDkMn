import crypto from "node:crypto";
import speakeasy from "speakeasy";

const COOKIE = "dkmn_auth";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const STEP_MS = 30_000;             // TOTP 步长 30 秒
const FAIL_WINDOW_MS = 5 * 60_000;
const FAIL_LIMIT = 5;

// 用 globalThis 保存状态，开发模式热重载时不会丢失
const G = (globalThis.__dkmnAuth ||= { lastStep: -1, fails: [] });

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function totpSecret() {
  const s = process.env.TOTP_SECRET;
  if (!s) throw httpError(500, "服务端未配置 TOTP_SECRET 环境变量");
  return s;
}

// 会话签名密钥：优先用 SESSION_SECRET，否则从 TOTP_SECRET 派生（重启后 Cookie 仍有效）
function signingKey() {
  return process.env.SESSION_SECRET
    || crypto.createHmac("sha256", "dkmn-session").update(totpSecret()).digest("hex");
}

function sign(exp) {
  return crypto.createHmac("sha256", signingKey()).update(`dkmn|${exp}`).digest("hex");
}

// 校验 6 位 TOTP 验证码：允许前后各 1 个时间窗口（±30 秒），同一码不可重复使用
export function verifyTotp(code) {
  const now = Date.now();
  G.fails = G.fails.filter((t) => now - t < FAIL_WINDOW_MS);
  if (G.fails.length >= FAIL_LIMIT) throw httpError(429, "失败次数过多，请 5 分钟后再试");

  if (!/^\d{6}$/.test(code)) { G.fails.push(now); return false; }

  const r = speakeasy.totp.verifyDelta({ secret: totpSecret(), encoding: "base32", token: code, window: 1 });
  const step = r ? Math.floor(now / STEP_MS) + r.delta : null;
  if (step === null || step <= G.lastStep) { G.fails.push(now); return false; }

  G.lastStep = step;
  return true;
}

// 签发 24 小时凭证：`${过期时间戳}.${HMAC签名}`
export function issueToken() {
  const exp = Date.now() + TTL_MS;
  return { token: `${exp}.${sign(exp)}`, exp };
}

function getCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// 返回有效的过期时间戳，无效或过期返回 null
export function sessionExp(req) {
  const raw = getCookie(req, COOKIE);
  if (!raw) return null;
  const [expStr, sig] = raw.split(".");
  const exp = Number(expStr);
  if (!Number.isSafeInteger(exp) || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return exp > Date.now() ? exp : null;
}

export function sessionCookie(token) {
  const secure = process.env.NODE_ENV === "production" || process.env.RENDER === "true" ? "; Secure" : "";
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}${secure}`;
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// 全局门禁：路由开头调用，返回 Response 则直接返回，返回 null 则放行
export function requireAuth(req) {
  try {
    if (sessionExp(req)) return null;
  } catch (e) {
    return Response.json({ error: e.message }, { status: e.status || 500 });
  }
  return Response.json(
    { error: "401 Unauthorized：请先通过 Google Authenticator 解锁（24 小时有效）" },
    { status: 401 }
  );
}
