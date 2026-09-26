// 查询樱花隧道状态（本地排查用，不会写入任何东西）
//
// 用法：
//   node tools/check-natfrp.js            # 列出全部隧道摘要
//   node tools/check-natfrp.js 29252938   # 只看指定隧道（ID 或名称）
//
// 访问密钥读取顺序：
//   1) 环境变量 NATFRP_TOKEN
//   2) E:\dsh\.secrets\natfrp-token.txt
//   3) <项目>\..\.secrets\natfrp-token.txt
//
// 隐私：公网地址默认打码显示（--full 可看完整地址）。

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const selector = args.find((a) => !a.startsWith('--')) || null;
const showFull = args.includes('--full');

function readToken() {
  const candidates = [
    process.env.NATFRP_TOKEN,
    'E:\\dsh\\.secrets\\natfrp-token.txt',
    path.join(root, '..', '.secrets', 'natfrp-token.txt')
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const t = fs.readFileSync(c, 'utf8').replace(/[\s"']/g, '');
      if (t) return t;
    } catch { /* 换下一个 */ }
  }
  return null;
}

function maskRemote(remote) {
  if (!remote) return '(未知)';
  if (showFull) return remote;
  const idx = remote.lastIndexOf(':');
  if (idx < 0) return remote.slice(0, 3) + '***';
  return remote.slice(0, 3) + '***' + remote.slice(idx);
}

(async () => {
  const token = readToken();
  if (!token) {
    console.error('✗ 找不到访问密钥，请保存到 E:\\dsh\\.secrets\\natfrp-token.txt');
    process.exit(1);
  }

  const res = await fetch('https://api.natfrp.com/v4/tunnels', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'mc-server-status-check'
    }
  });
  if (!res.ok) {
    console.error(`✗ 樱花 API 请求失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }

  const tunnels = await res.json();
  if (!Array.isArray(tunnels)) {
    console.error('✗ 返回内容不是数组：', JSON.stringify(tunnels).slice(0, 200));
    process.exit(1);
  }

  const list = selector
    ? tunnels.filter((t) => String(t.id) === String(selector) || t.name === selector)
    : tunnels;

  if (!list.length) {
    console.error(`✗ 没找到隧道 "${selector}"（账号下共 ${tunnels.length} 条）`);
    process.exit(1);
  }

  console.log(`共有 ${tunnels.length} 条隧道，显示 ${list.length} 条：\n`);
  for (const t of list) {
    console.log(`隧道 ${t.id}  名称 ${t.name}  类型 ${t.type}`);
    console.log(`  在线状态 : ${t.online ? '在线 ✅' : '离线 ❌'}`);
    console.log(`  status   : ${t.status}${t.status_reason ? '（' + t.status_reason + '）' : ''}`);
    console.log(`  本地目标 : ${t.local_ip}:${t.local_port}   ← 心跳脚本要 ping 的端口`);
    console.log(`  公网地址 : ${maskRemote(t.remote)}`);
    console.log(`  节点     : #${t.node}`);
    console.log('');
  }
})();
