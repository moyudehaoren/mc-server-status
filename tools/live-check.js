// 快速查看线上两个 JSON（Node 出网比 PowerShell 稳，带硬超时）
// 用法： node tools/live-check.js
const https = require('node:https');

const base = 'https://moyudehaoren.github.io/mc-server-status/';
const files = ['status.json', 'tunnel.json'];

function get(path, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const url = base + path + '?t=' + Date.now();
    const req = https.get(url, { headers: { 'user-agent': 'mc-status-check' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, status: 'timeout', body: '' });
    });
    req.on('error', (e) => resolve({ ok: false, status: e.code || e.message, body: '' }));
  });
}

(async () => {
  for (const f of files) {
    const r = await get(f);
    if (!r.ok) {
      console.log(`${f}: 读取失败 (${r.status})`);
      continue;
    }
    try {
      const j = JSON.parse(r.body);
      const ageMin = j.updated_at ? ((Date.now() - Date.parse(j.updated_at)) / 60000).toFixed(1) : '?';
      if (f === 'status.json') {
        console.log(`status.json : online=${j.online} ${j.count}/${j.max} 玩家=[${(j.players || []).join(',')}] 版本=${j.version} 更新于 ${j.updated_at}（${ageMin} 分钟前）`);
        if (j.machine) console.log(`              电脑: CPU ${j.machine.cpu_percent}% 内存 ${j.machine.mem_percent}% (${j.machine.mem_used_gb}/${j.machine.mem_total_gb} GB)`);
      } else {
        console.log(`tunnel.json : online=${j.online} 隧道=${j.name} 更新于 ${j.updated_at}（${ageMin} 分钟前）`);
      }
    } catch (e) {
      console.log(`${f}: 解析失败 ${e.message}`);
    }
  }
})();
