import { httpError } from "./auth";
import { assertSafeUrl } from "./urlGuard";

const MAX_BYTES = 15 * 1024; // 15360 字节
const MAX_SERVERS = 10;
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const ALLOWED_COMMANDS = new Set(["npx", "uvx", "node", "python", "python3"]);
// 参数中禁止的 shell 特殊符号（虽然 spawn 不经过 shell，仍作为纵深防御）
const SHELL_META = /[;&|`$<>(){}\[\]\\'"*?!~#\r\n\0]/;
// 禁止通过环境变量注入代码或劫持动态链接
const BLOCKED_ENV = /^(LD_|DYLD_|NODE_OPTIONS$|PYTHONSTARTUP$|PYTHONPATH$|BASH_ENV$|ENV$)/;

// 校验用户提交的 mcpServers JSON 字符串，通过后返回规范化的配置对象
export async function parseMcpConfig(raw) {
  if (typeof raw !== "string") throw httpError(400, "config 必须是 JSON 字符串");

  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_BYTES) throw httpError(413, `MCP 配置超过 15KB 限制（当前 ${bytes} 字节，上限 15360 字节）`);

  let cfg;
  try { cfg = JSON.parse(raw); } catch { throw httpError(400, "MCP 配置不是合法的 JSON"); }

  const servers = cfg?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    throw httpError(400, "JSON 必须包含 mcpServers 对象");

  const names = Object.keys(servers);
  if (names.length === 0 || names.length > MAX_SERVERS)
    throw httpError(400, `mcpServers 数量需在 1 到 ${MAX_SERVERS} 之间`);

  const out = {};
  for (const name of names) {
    if (!NAME.test(name)) throw httpError(400, `服务器名称不合法：${name}（仅允许字母、数字、_ 和 -）`);
    out[name] = await checkServer(name, servers[name]);
  }
  return out;
}

async function checkServer(name, c) {
  if (!c || typeof c !== "object" || Array.isArray(c))
    throw httpError(400, `${name} 的配置必须是对象`);

  if ("command" in c) {
    if (typeof c.command !== "string" || !ALLOWED_COMMANDS.has(c.command))
      throw httpError(400, `${name}: command "${c.command}" 不在允许列表（${[...ALLOWED_COMMANDS].join(", ")}）中`);

    const args = c.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string" || a.length > 500 || SHELL_META.test(a)))
      throw httpError(400, `${name}: args 必须是字符串数组，且不能包含 shell 特殊符号`);

    const env = {};
    for (const [k, v] of Object.entries(c.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || BLOCKED_ENV.test(k) || typeof v !== "string")
        throw httpError(400, `${name}: 环境变量 ${k} 不允许使用`);
      env[k] = v;
    }
    return { command: c.command, args, env };
  }

  if ("url" in c) {
    if (typeof c.url !== "string") throw httpError(400, `${name}: url 必须是字符串`);
    try { await assertSafeUrl(c.url); }
    catch (e) { throw httpError(400, `${name}: ${e.message}`); }

    const headers = {};
    for (const [k, v] of Object.entries(c.headers ?? {})) {
      if (typeof v !== "string") throw httpError(400, `${name}: 请求头 ${k} 必须是字符串`);
      headers[k] = v;
    }
    return { url: c.url, headers };
  }

  throw httpError(400, `${name} 需要 command 或 url 字段`);
}
