/*
  Peekabo 服务器流量信息面板 (Surge Panel) —— 多服务器版
  逻辑参考: xream/scripts → surge/modules/sub-store-scripts/sub-info/peekabo.js
  API: GET https://vf-hk.peekabo.io/api/server/{id}?state=true
  已用流量按服务器出站流量(tx)统计, 与 Peekabo 计费口径一致
  地区: ip-api.com 反查(中文), 失败回退 ipwho.is, 结果经 $persistentStore 缓存 24h

  依赖参数(argument):
    编号写法(推荐, 配合 .sgmodule 的独立输入框, 每台服务器名称/ID/Token 分开填, 不用手动拼接):
      name1=<名称>&id1=<服务器ID>&token1=<API Token>
      name2=<名称>&id2=<服务器ID>&token2=<API Token>
      name3=<名称>&id3=<服务器ID>&token3=<API Token>
      当前配套的 .sgmodule 提供 3 组输入框(最多 3 台), 名称可留空(留空时使用 API 返回的服务器名)
      某一编号的 id/token 留空则该编号自动跳过, 不需要凑满

    组合字符串写法(可选, 一个字段塞多台, 兼容旧配置):
      servers=<名称1>@<ID1>:<Token1>,<名称2>@<ID2>:<Token2>,...
      servers=@id1:token1,HK节点@id2:token2

    单服务器写法(向下兼容最早期的单机模块):
      id=<服务器ID>&token=<API Token>

    以上写法可以同时使用, 结果会自动合并去重, 也可以只用其中一种。

    通用可选参数:
      icon=<SF Symbol>            面板图标, 默认 xserve
      icon-color=<6位HEX不含#>     面板图标颜色, 默认 3B82F6
      ip-mode=<full|mask|hide>    IP 显示模式, 默认 mask
*/

const ARGS = parseArgs($argument || "");

const GEO_CACHE_TTL = 24 * 60 * 60; // 24h
const NOTIFY_DAYS = 5; // 剩余天数 <= 5 时发送到期提醒
const PANEL_TITLE = "Peekabo Server"; // 面板标题
const PANEL_ICON = ARGS.icon || "xserve"; // 面板图标(SF Symbol), 模块参数可配置
const ERROR_ICON = "exclamationmark.triangle.fill"; // 错误态图标
// 图标颜色(6位HEX, 不含#), 模块参数可配置
const PANEL_ICON_COLOR = /^[0-9a-fA-F]{6}$/.test(String(ARGS["icon-color"] || "").trim())
  ? `#${String(ARGS["icon-color"]).trim()}`
  : "#3B82F6";
const ERROR_COLOR = "#EF4444"; // 错误态
// IP 显示模式: full 完整 / mask 后两段打码 / hide 隐藏
const ipModeRaw = String(ARGS["ip-mode"] || "mask").toLowerCase();
const IP_MODE = ["full", "mask", "hide"].includes(ipModeRaw) ? ipModeRaw : "mask";

function maskIp(ip) {
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
  return ip;
}

// 安全解码: 值含 % 或无效编码时不抛错, 原样返回
function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str;
  }
}

function parseArgs(str) {
  const out = {};
  if (!str) return out;
  for (const pair of str.split("&")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = safeDecode(pair.slice(0, idx)).trim();
    const value = safeDecode(pair.slice(idx + 1)).trim();
    if (key) out[key] = value;
  }
  return out;
}

const MAX_NUMBERED_SERVERS = 3; // 编号字段 name{n}/id{n}/token{n} 最多扫描到几号(需与 .sgmodule 的输入框数量一致)

// 解析多服务器配置, 返回 [{ label, id, token }, ...]
// 合并三种来源(可同时使用, 自动按 id:token 去重):
//   1. 编号字段 name1/id1/token1 ... nameN/idN/tokenN
//   2. servers=名称@ID:Token,名称@ID:Token 组合字符串
//   3. 旧版单服务器 id=&token= (无编号)
function parseServers() {
  const list = [];
  const seen = new Set();

  function pushServer(label, id, token) {
    id = String(id || "").trim();
    token = String(token || "").trim();
    if (!id || !token) return;
    const key = `${id}:${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ label: String(label || "").trim(), id, token });
  }

  // 1. 编号字段: name1/id1/token1 ...
  for (let i = 1; i <= MAX_NUMBERED_SERVERS; i++) {
    const id = ARGS[`id${i}`];
    const token = ARGS[`token${i}`];
    if (id === undefined && token === undefined) continue; // 该编号未出现, 跳过
    pushServer(ARGS[`name${i}`], id, token);
  }

  // 2. servers= 组合字符串写法
  if (ARGS.servers) {
    for (const raw of ARGS.servers.split(",")) {
      const item = raw.trim();
      if (!item) continue;

      let label = "";
      let rest = item;
      const atIdx = rest.indexOf("@");
      if (atIdx >= 0) {
        label = rest.slice(0, atIdx).trim();
        rest = rest.slice(atIdx + 1);
      }

      const colonIdx = rest.indexOf(":");
      if (colonIdx < 0) continue; // 缺少 token, 跳过该条

      pushServer(label, rest.slice(0, colonIdx), rest.slice(colonIdx + 1));
    }
  }

  // 3. 向下兼容: 最早期的单服务器 id/token 参数(无编号)
  if (ARGS.id && ARGS.token) {
    pushServer(ARGS.name, ARGS.id, ARGS.token);
  }

  return list;
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    $httpClient.get(
      { url, headers, timeout: 10000 },
      (error, response, data) => {
        if (error) reject(new Error(error));
        else resolve({ status: response.status, body: data });
      }
    );
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "N/A";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 2)} ${units[i]}`;
}

function formatDate(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function composeRegion(country, regionName, city) {
  const parts = [];
  if (country) parts.push(country);
  if (regionName && regionName !== country && !parts.includes(regionName)) parts.push(regionName);
  if (city && !parts.includes(city)) parts.push(city);
  return parts.join(" ") || null;
}

async function getGeo(ip) {
  const key = `peekabo_geo_${ip}`;
  try {
    const cached = $persistentStore.read(key);
    if (cached) {
      const obj = JSON.parse(cached);
      if (Date.now() - obj.ts < GEO_CACHE_TTL) return obj.region;
    }
  } catch (_) {}

  let region = null;
  // 主: ip-api.com (中文)
  try {
    const res = await httpGet(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city,query`,
      { Accept: "application/json" }
    );
    if (res.status === 200) {
      const geo = JSON.parse(res.body);
      if (geo && geo.status === "success") {
        region = composeRegion(geo.country, geo.regionName, geo.city);
      }
    }
  } catch (_) {}

  // 备: ipwho.is (https)
  if (!region) {
    try {
      const res = await httpGet(`https://ipwho.is/${encodeURIComponent(ip)}`, {
        Accept: "application/json",
      });
      if (res.status === 200) {
        const geo = JSON.parse(res.body);
        if (geo && geo.success) {
          region = composeRegion(geo.country, geo.region, geo.city);
        }
      }
    } catch (_) {}
  }

  try {
    $persistentStore.write(JSON.stringify({ region, ts: Date.now() }), key);
  } catch (_) {}
  return region;
}

// 剩余天数 <= NOTIFY_DAYS 时发送通知, 按"服务器+天"去重(每台服务器每天最多一次)
function notifyExpiring(serverId, daysLeft, planName, expire) {
  if (daysLeft > NOTIFY_DAYS) return;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const key = `peekabo_notify_${serverId}_${today}`;
  try {
    if ($persistentStore.read(key)) return; // 今天已通知过
    $notification.post(
      "Peekabo 流量提醒",
      `${planName} 剩余 ${daysLeft} 天`,
      `到期时间: ${formatDate(expire)}，请及时续费`
    );
    $persistentStore.write("1", key);
  } catch (_) {}
}

function finish(title, content, icon, iconColor) {
  $done({ title, content, icon, "icon-color": iconColor });
}

function fail(msg) {
  finish(PANEL_TITLE, `❌ ${msg}`, ERROR_ICON, ERROR_COLOR);
}

// 拉取单台服务器信息, 成功/失败都返回结果对象而不是抛错, 便于多台并发互不影响
async function fetchOneServer(server) {
  const { label, id, token } = server;
  const fallbackName = label || id;

  try {
    const res = await httpGet(
      `https://vf-hk.peekabo.io/api/server/${encodeURIComponent(id)}?state=true`,
      { Accept: "application/json", Authorization: `Bearer ${token}` }
    );

    if (res.status !== 200) {
      return { ok: false, name: fallbackName, error: `API 请求失败 (HTTP ${res.status})` };
    }

    let json;
    try {
      json = JSON.parse(res.body);
    } catch (_) {
      return { ok: false, name: fallbackName, error: "API 响应解析失败" };
    }

    const data = json.data;
    const traffic = data?.state?.network?.primary?.traffic;
    const limitMatch = String(data?.network?.primary?.limit || "")
      .trim()
      .match(/^(\d+(?:\.\d+)?)\s*GB$/i);
    const used = traffic?.tx; // 出站流量
    const total = limitMatch ? Number(limitMatch[1]) * 1024 ** 3 : NaN;
    const expire = Math.floor(Date.parse(data?.currentMonthlyPeriod?.end) / 1000);
    const planName = String(data?.name || "").trim();
    const ip = data?.network?.primary?.ipv4?.[0]?.address || "";

    if (
      ![used, total, expire].every(Number.isSafeInteger) ||
      used < 0 ||
      total <= 0 ||
      expire <= 0 ||
      !planName
    ) {
      return { ok: false, name: label || planName || id, error: "API 返回的流量信息不完整" };
    }

    // 地区反查(带缓存, 失败不阻塞面板)
    const region = ip ? await getGeo(ip) : null;

    const usedText = formatBytes(used);
    const totalText = formatBytes(total);
    const percent = ((used / total) * 100).toFixed(2);
    const now = Math.floor(Date.now() / 1000);
    const daysLeft = Math.max(0, Math.ceil((expire - now) / 86400));
    const displayName = label || planName;

    // 剩余 <= NOTIFY_DAYS 天时发送到期通知(按服务器 ID 去重)
    notifyExpiring(id, daysLeft, displayName, expire);

    return {
      ok: true,
      name: displayName,
      ip,
      ipText: IP_MODE === "hide" ? null : IP_MODE === "mask" ? maskIp(ip) : ip,
      region,
      usedText,
      totalText,
      percent,
      daysLeft,
      expireText: formatDate(expire),
    };
  } catch (e) {
    return { ok: false, name: fallbackName, error: String((e && e.message) || e) };
  }
}

(async () => {
  try {
    const servers = parseServers();
    if (!servers.length) {
      return fail("缺少 id/token 参数, 或 servers 参数格式错误(示例: servers=HK@id1:token1,US@id2:token2)");
    }

    const results = await Promise.all(servers.map(fetchOneServer));
    const okResults = results.filter((r) => r.ok);
    const errResults = results.filter((r) => !r.ok);

    if (!okResults.length) {
      // 全部失败, 汇总错误信息
      const msg = errResults.map((r) => `${r.name}: ${r.error}`).join(" | ");
      return fail(msg);
    }

    // 剩余天数少的排前面, 优先提醒即将到期的服务器
    okResults.sort((a, b) => a.daysLeft - b.daysLeft);

    const blocks = okResults.map((r) => {
      const lines = [
        `📡 ${r.name}`,
        r.ipText ? `IP: ${r.ipText}` : null,
        `地区: ${r.region || "未知"}`,
        `已用: ${r.usedText} / ${r.totalText} (${r.percent}%)`,
        `剩余: ${r.daysLeft} 天 · 到期: ${r.expireText}`,
      ].filter(Boolean);
      return lines.join("\n");
    });

    for (const r of errResults) {
      blocks.push(`⚠️ ${r.name}: ${r.error}`);
    }

    const title = servers.length > 1 ? `${PANEL_TITLE} · 共${servers.length}台` : PANEL_TITLE;
    const content = blocks.join("\n――――――――\n");

    finish(title, content, PANEL_ICON, PANEL_ICON_COLOR);
  } catch (e) {
    fail(String((e && e.message) || e));
  }
})();
