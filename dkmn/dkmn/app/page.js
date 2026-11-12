"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

const HINT = {
  openai: ["gpt-4o", "https://api.openai.com/v1"],
  anthropic: ["claude-sonnet-4-5", "https://api.anthropic.com"],
  gemini: ["gemini-2.5-flash", "https://generativelanguage.googleapis.com"],
};
const DEF = {
  provider: "openai", apiKey: "", baseUrl: "", model: "gpt-4o",
  mcp: JSON.stringify({ mcpServers: { filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } } }, null, 2),
};

function Md({ text }) {
  return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{text}</ReactMarkdown></div>;
}

function Tool({ p }) {
  const st = p.result === undefined ? "running" : p.isError ? "err" : "ok";
  return (
    <details className={"tool " + st}>
      <summary>{p.name} <i>{st === "running" ? "调用中…" : st === "ok" ? "完成" : "出错"}</i></summary>
      <b>参数</b><pre>{JSON.stringify(p.args, null, 2)}</pre>
      {p.result !== undefined && <><b>返回</b><pre>{p.result}</pre></>}
    </details>
  );
}

export default function Page() {
  const [cfg, setCfg] = useState(DEF);
  const [ready, setReady] = useState(false);
  const [auth, setAuth] = useState({ checked: false, unlocked: false, exp: null });
  const [code, setCode] = useState("");
  const [authMsg, setAuthMsg] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [servers, setServers] = useState([]);
  const [err, setErr] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef(null);

  const unlocked = auth.unlocked;

  const refreshAuth = () =>
    fetch("/api/auth/verify")
      .then((r) => r.json())
      .then((d) => setAuth({ checked: true, unlocked: !!d.unlocked, exp: d.expiresAt || null }))
      .catch(() => setAuth({ checked: true, unlocked: false, exp: null }));

  useEffect(() => {
    try { const s = localStorage.getItem("dkmn.cfg"); if (s) setCfg({ ...DEF, ...JSON.parse(s) }); } catch {}
    setReady(true);
    refreshAuth();
  }, []);
  useEffect(() => { if (ready) localStorage.setItem("dkmn.cfg", JSON.stringify(cfg)); }, [cfg, ready]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  // 24 小时到期后自动切回锁定状态
  useEffect(() => {
    if (!auth.exp) return;
    const t = setTimeout(() => setAuth({ checked: true, unlocked: false, exp: null }),
      Math.max(0, auth.exp - Date.now()));
    return () => clearTimeout(t);
  }, [auth.exp]);

  // 解锁后才加载 MCP 服务器列表
  useEffect(() => {
    if (!unlocked) { setServers([]); return; }
    fetch("/api/mcp").then((r) => (r.ok ? r.json() : Promise.reject())).then((d) => setServers(d.servers || [])).catch(() => {});
  }, [unlocked]);

  const set = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }));
  const pickProvider = (e) => { const p = e.target.value; setCfg((c) => ({ ...c, provider: p, model: HINT[p][0], baseUrl: "" })); };

  async function verify() {
    if (!/^\d{6}$/.test(code)) { setAuthMsg("请输入 6 位数字验证码"); return; }
    setVerifying(true); setAuthMsg("");
    try {
      const r = await fetch("/api/auth/verify", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (r.ok) { setAuth({ checked: true, unlocked: true, exp: d.expiresAt }); setCode(""); }
      else setAuthMsg(d.error || "验证失败");
    } catch (e) { setAuthMsg("网络错误：" + e.message); }
    setVerifying(false);
  }

  async function lock() {
    await fetch("/api/auth/verify", { method: "DELETE" });
    setAuth({ checked: true, unlocked: false, exp: null });
  }

  async function connect() {
    if (!unlocked) return;
    setConnecting(true); setErr("");
    try {
      const r = await fetch("/api/mcp", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: cfg.mcp }),
      });
      const d = await r.json();
      if (r.status === 401) { setAuth((a) => ({ ...a, unlocked: false })); setErr(d.error); }
      else if (!r.ok) setErr(d.error || "连接失败");
      else setServers(d.servers);
    } catch (e) { setErr(e.message); }
    setConnecting(false);
  }

  async function send() {
    const q = input.trim(); if (!q || busy) return;
    if (!unlocked) { setAuthMsg("请先在顶部输入 Google Authenticator 验证码解锁"); return; }
    const history = [...msgs.map((m) => ({ role: m.role, content: m.role === "user" ? m.text : m.parts.filter((p) => p.type === "text").map((p) => p.text).join("") })), { role: "user", content: q }];
    setInput(""); setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: q }, { role: "assistant", parts: [] }]);
    const upd = (fn) => setMsgs((m) => { const c = [...m]; const a = { ...c.at(-1), parts: [...c.at(-1).parts] }; fn(a.parts); c[c.length - 1] = a; return c; });
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cfg, messages: history }) });
      if (res.status === 401) { setAuth((a) => ({ ...a, unlocked: false })); throw new Error("登录已过期，请重新输入验证码解锁"); }
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          const e = JSON.parse(line);
          if (e.t === "text") upd((p) => { const last = p.at(-1); if (last?.type === "text") p[p.length - 1] = { ...last, text: last.text + e.v }; else p.push({ type: "text", text: e.v }); });
          else if (e.t === "tool") upd((p) => p.push({ type: "tool", id: e.id, name: e.name, args: e.args }));
          else if (e.t === "result") upd((p) => { const i = p.findIndex((x) => x.id === e.id); if (i >= 0) p[i] = { ...p[i], result: e.result, isError: e.isError }; });
          else if (e.t === "error") upd((p) => p.push({ type: "text", text: "⚠️ " + e.v }));
        }
      }
    } catch (e) { upd((p) => p.push({ type: "text", text: "⚠️ " + e.message })); }
    setBusy(false);
  }

  return (
    <div className="shell">
      <header className="authbar">
        <strong className="brand">DkMn</strong>
        {!auth.checked ? (
          <span className="muted">检查解锁状态…</span>
        ) : unlocked ? (
          <>
            <span className="ok">已解锁（24小时内有效，至 {new Date(auth.exp).toLocaleString()}）</span>
            <button className="ghost" onClick={lock}>锁定</button>
          </>
        ) : (
          <>
            <span className="muted">请打开 Google Authenticator 输入 6 位动态码解锁</span>
            <input className="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={code} placeholder="000000"
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter") verify(); }} />
            <button onClick={verify} disabled={verifying || code.length !== 6}>{verifying ? "验证中…" : "验证"}</button>
          </>
        )}
        {authMsg && <span className="error">{authMsg}</span>}
      </header>

      <div className="app">
        <aside>
          <h1>DkMn</h1>
          <label>模型服务商
            <select value={cfg.provider} onChange={pickProvider}>
              <option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option>
            </select>
          </label>
          <label>API Key<input type="password" value={cfg.apiKey} onChange={set("apiKey")} placeholder="sk-..." /></label>
          <label>Base URL<input value={cfg.baseUrl} onChange={set("baseUrl")} placeholder={HINT[cfg.provider][1]} /></label>
          <label>模型<input value={cfg.model} onChange={set("model")} /></label>
          <label>MCP 配置（mcpServers JSON，上限 15KB）
            <textarea rows={9} spellCheck={false} value={cfg.mcp} onChange={set("mcp")} />
          </label>
          <button onClick={connect} disabled={connecting || !unlocked}>{connecting ? "连接中…" : "连接 MCP"}</button>
          {err && <p className="error">{err}</p>}
          <div className="servers">
            {servers.length === 0 && <p className="muted">{unlocked ? "尚未连接任何 MCP Server。" : "解锁后可连接 MCP Server。"}</p>}
            {servers.map((s) => (
              <details key={s.name} open>
                <summary><span className={"dot " + s.status} />{s.name}<i>{s.status === "connected" ? `${s.tools.length} 个工具` : "失败"}</i></summary>
                {s.error && <p className="error">{s.error}</p>}
                <ul>{s.tools.map((t) => <li key={t.name} title={t.description}>{t.name}</li>)}</ul>
              </details>
            ))}
          </div>
        </aside>

        <main>
          <div className="feed">
            {msgs.length === 0 && (
              <div className="empty">
                <h2>今天想做点什么？</h2>
                <p className="muted">{unlocked ? "连接 MCP 后，模型会在需要时自动调用工具。" : "请先在顶部解锁，再开始对话。"}</p>
              </div>
            )}
            {msgs.map((m, i) => m.role === "user"
              ? <div key={i} className="row user"><div className="bubble">{m.text}</div></div>
              : <div key={i} className="row">{m.parts.map((p, j) => p.type === "tool" ? <Tool key={j} p={p} /> : <Md key={j} text={p.text} />)}
                  {busy && i === msgs.length - 1 && m.parts.length === 0 && <span className="muted">思考中…</span>}</div>)}
            <div ref={end} />
          </div>
          <div className="composer">
            <textarea rows={1} value={input} disabled={!unlocked}
              placeholder={unlocked ? "给 DkMn 发送消息" : "请先解锁"}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
            <button onClick={send} disabled={busy || !input.trim() || !unlocked}>发送</button>
          </div>
        </main>
      </div>
    </div>
  );
}
