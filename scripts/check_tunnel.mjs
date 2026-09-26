// 查询 SakuraFrp 隧道在线状态并写入 tunnel.json
//
// 由 .github/workflows/tunnel-check.yml 每 5 分钟调用一次。
// 需要的环境变量：
//   NATFRP_TOKEN  樱花访问密钥（放在仓库 Secrets 里）
//   NATFRP_TUNNEL 隧道 ID 或隧道名称（放在仓库 Variables 里）
// 可选：
//   TUNNEL_JSON              输出文件路径（默认 tunnel.json）
//   TUNNEL_KEEPALIVE_MINUTES 状态无变化时的最长写入间隔（默认 30 分钟）
//
// 只写入 online / status / status_reason / name —— 不写 remote（公网地址），
// 避免把连接地址公开到仓库里。

import fs from 'node:fs';

const API = 'https://api.natfrp.com/v4/tunnels';
const token = (process.env.NATFRP_TOKEN || '').trim();
const selector = (process.env.NATFRP_TUNNEL || '').trim();
const outFile = process.env.TUNNEL_JSON || 'tunnel.json';
const keepAliveMinutes = Number(process.env.TUNNEL_KEEPALIVE_MINUTES || 30);

if (!token || !selector) {
  console.log('::notice::未配置 NATFRP_TOKEN / NATFRP_TUNNEL，跳过隧道检测（tunnel.json 保持不变）');
  process.exit(0);
}

const res = await fetch(API, {
  headers: {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'mc-server-status-tunnel-check',
    Accept: 'application/json'
  }
});

if (!res.ok) {
  const body = (await res.text()).slice(0, 300);
  console.error(`::error::SakuraFrp API 请求失败 HTTP ${res.status} - ${body}`);
  process.exit(1);
}

const tunnels = await res.json();
if (!Array.isArray(tunnels)) {
  console.error('::error::SakuraFrp API 返回了非数组内容');
  process.exit(1);
}

const tunnel = tunnels.find(
  (t) => String(t.id) === String(selector) || t.name === selector
);

if (!tunnel) {
  console.error(`::error::未找到隧道 "${selector}"（共 ${tunnels.length} 条隧道）`);
  process.exit(1);
}

const next = {
  online: tunnel.online === true,
  status: typeof tunnel.status === 'number' ? tunnel.status : null,
  status_reason: tunnel.status_reason ?? null,
  name: tunnel.name ?? null,
  updated_at: new Date().toISOString(),
  source: 'sakurafrp-api'
};

let prev = null;
try {
  prev = JSON.parse(fs.readFileSync(outFile, 'utf8'));
} catch {
  prev = null;
}

const stateChanged =
  !prev || prev.online !== next.online || prev.status !== next.status;

const prevAgeMinutes = prev?.updated_at
  ? (Date.now() - Date.parse(prev.updated_at)) / 60000
  : Infinity;

if (!stateChanged && prevAgeMinutes < keepAliveMinutes) {
  console.log(
    `隧道状态无变化（${next.online ? '在线' : '离线'}），距上次写入 ${prevAgeMinutes.toFixed(1)} 分钟，跳过`
  );
  process.exit(0);
}

fs.writeFileSync(outFile, JSON.stringify(next, null, 2) + '\n');
console.log(
  `tunnel.json 已更新：${next.name ?? selector} ${next.online ? '在线' : '离线'}` +
    (next.status_reason ? `（${next.status_reason}）` : '')
);
