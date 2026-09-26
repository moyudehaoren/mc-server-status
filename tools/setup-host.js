// 生成主机端配置 scripts/host.config.json
//
// 令牌从 .secrets 里读取，全程不会打印出来。
//
// 用法：
//   node tools/setup-host.js                     # 默认端口 25565
//   node tools/setup-host.js --port 25566
//   node tools/setup-host.js --owner 某某 --repo 某仓库
//
// 会先验证令牌对目标仓库确实有写权限（permissions.push），再写配置。

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const owner = argVal('--owner', 'moyudehaoren');
const repo = argVal('--repo', 'mc-server-status');
const branch = argVal('--branch', 'main');
const port = Number(argVal('--port', '25565'));

const tokenCandidates = [
  process.env.MC_STATUS_TOKEN,
  'E:\\dsh\\.secrets\\gh-token-heartbeat.txt',
  path.join(root, '..', '.secrets', 'gh-token-heartbeat.txt')
];

function readToken() {
  for (const c of tokenCandidates) {
    if (!c) continue;
    try {
      const t = fs.readFileSync(c, 'utf8').replace(/[\s"']/g, '');
      if (t) return t;
    } catch { /* 换下一个 */ }
  }
  return null;
}

(async () => {
  const token = readToken();
  if (!token) {
    console.error('✗ 找不到心跳令牌，请保存到 E:\\dsh\\.secrets\\gh-token-heartbeat.txt');
    process.exit(1);
  }

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mc-server-status-setup',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  const info = await res.json();
  if (!res.ok) {
    console.error(`✗ 令牌无法访问 ${owner}/${repo}：HTTP ${res.status} ${info.message || ''}`);
    process.exit(1);
  }

  const canPush = info.permissions && info.permissions.push === true;
  console.log(`✓ 令牌可访问 ${info.full_name}（${info.private ? '私有' : '公开'}）`);
  console.log(`  写权限：${canPush ? '有 ✓' : '没有 ✗ —— 请把令牌的 Contents 设为 Read and write'}`);
  if (!canPush) process.exit(1);

  const cfgPath = path.join(root, 'scripts', 'host.config.json');
  const cfg = {
    owner,
    repo,
    branch,
    token,
    serverHost: '127.0.0.1',
    serverPort: port,
    protocolVersion: 767,
    timeoutMs: 3000,
    keepAliveMinutes: 10
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`✓ 已写入 scripts/host.config.json（serverPort = ${port}，令牌写在里面但已被 .gitignore 忽略）`);
  console.log('');
  console.log('下一步：');
  console.log('  1) powershell -ExecutionPolicy Bypass -File scripts\\update_status.ps1 -Force');
  console.log('  2) powershell -ExecutionPolicy Bypass -File scripts\\register-task.ps1');
})();
