// 生成演示数据，用于本地预览页面在各种状态下的样子。
//
// 用法：
//   node tools/demo-data.js online    # 开服中：3 名玩家 + 隧道在线
//   node tools/demo-data.js offline   # 未开服
//   node tools/demo-data.js stale     # 主机失联：status.json 声称在线但时间戳很旧
//
// 注意：这个脚本会覆盖 status.json / tunnel.json，正式使用前请重新跑一次
// 心跳脚本（或手工把 updated_at 改回 null）。

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mode = (process.argv[2] || 'online').toLowerCase();
const now = new Date().toISOString();
const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 一小时前

const statusFile = path.join(root, 'status.json');
const tunnelFile = path.join(root, 'tunnel.json');

// 演示用的机器数据（真实数据由心跳脚本用 CIM 采集）
const machine = {
  cpu_percent: 23.5,
  mem_percent: 61.2,
  mem_used_gb: 9.6,
  mem_total_gb: 15.6,
  uptime_minutes: 248.3
};

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

if (mode === 'offline') {
  write(statusFile, {
    online: false, players: [], count: 0, max: null,
    version: null, updated_at: now, source: 'demo', machine
  });
  write(tunnelFile, {
    online: false, status: null, status_reason: null,
    name: 'MC-LAN', updated_at: now, source: 'demo'
  });
  console.log('已生成【未开服】演示数据');
} else if (mode === 'stale') {
  write(statusFile, {
    online: true, players: ['Steve', 'Alex'], count: 2, max: 20,
    version: '1.21.4', updated_at: old, source: 'demo', machine
  });
  write(tunnelFile, {
    online: false, status: null, status_reason: null,
    name: 'MC-LAN', updated_at: now, source: 'demo'
  });
  console.log('已生成【主机失联】演示数据（status.json 时间戳是 1 小时前）');
} else {
  write(statusFile, {
    online: true, players: ['Steve', 'Alex', 'Notch'], count: 3, max: 20,
    version: '1.21.4', updated_at: now, source: 'demo', machine
  });
  write(tunnelFile, {
    online: true, status: 0, status_reason: null,
    name: 'MC-LAN', updated_at: now, source: 'demo'
  });
  console.log('已生成【开服中】演示数据（3 名玩家 + 隧道在线）');
}
