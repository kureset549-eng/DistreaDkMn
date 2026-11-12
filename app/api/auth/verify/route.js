import { verifyTotp, issueToken, sessionCookie, clearCookie, sessionExp } from "@/lib/auth";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

// 查询当前是否已解锁
export async function GET(req) {
  try {
    const exp = sessionExp(req);
    return Response.json({ unlocked: !!exp, expiresAt: exp || null });
  } catch (e) {
    return Response.json({ error: e.message }, { status: e.status || 500 });
  }
}

// 提交 6 位 Google Authenticator 验证码，通过后下发 24 小时 HttpOnly Cookie
export async function POST(req) {
  let code = "";
  try { code = String((await req.json()).code ?? "").trim(); } catch {}
  try {
    if (!verifyTotp(code))
      return Response.json({ error: "验证码错误或已过期，请确认手机时间已自动同步" }, { status: 401 });
    const { token, exp } = issueToken();
    return Response.json({ unlocked: true, expiresAt: exp }, {
      headers: { "Set-Cookie": sessionCookie(token) },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: e.status || 500 });
  }
}

// 手动锁定
export async function DELETE() {
  return Response.json({ unlocked: false }, { headers: { "Set-Cookie": clearCookie() } });
}
