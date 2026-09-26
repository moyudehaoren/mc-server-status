// 自动化测试：启动内置假 MC 服务器，跑心跳脚本的 DryRun（在线 + 离线两条分支）。
//
// 用法：
//   node tools/test-heartbeat.js            # 默认连 127.0.0.1（正常机器用这个）
//   node tools/test-heartbeat.js 192.168.x.x # 指定目标地址
//
// 说明：
//  - 假服务器监听 0.0.0.0，所以用回环或局域网地址都能连
//  - 子进程用 stdio:'inherit'（不是管道）：DSH 沙箱禁止管道 spawn
//  - 在 DSH 沙箱里，PowerShell 子进程连不到兄弟 Node 进程的回环端口，
//    这时改用本机局域网地址即可（正常 Windows 上不会有这个问题）

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(projectRoot, 'scripts', 'update_status.ps1');
const PORT = 25566;       // 假服务器端口（故意不用 25565，避免干扰真服务器）
const DEAD_PORT = 25599;  // 没有监听的端口
const targetHost = process.argv[2] || '127.0.0.1';

if (!fs.existsSync(scriptPath)) {
  console.error('找不到脚本：' + scriptPath);
  process.exit(1);
}

// ── 假 MC 服务器（只实现 Server List Ping） ────────────────────────────────
function writeVarInt(value) {
  const bytes = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset) {
  let result = 0, shift = 0, pos = offset;
  for (;;) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('VarInt too long');
  }
  return { value: result >>> 0, offset: pos };
}

const names = ['Steve', 'Alex'];

function buildStatusPacket() {
  const status = {
    version: { name: '1.21.4', protocol: 767 },
    players: {
      max: 20,
      online: names.length,
      sample: names.map((name) => ({ name, id: '00000000-0000-0000-0000-000000000000' }))
    },
    description: { text: 'Mock Minecraft Server' }
  };
  const json = Buffer.from(JSON.stringify(status), 'utf8');
  const body = Buffer.concat([Buffer.from([0x00]), writeVarInt(json.length), json]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

const sockets = [];
const server = net.createServer((socket) => {
  sockets.push(socket);
  let buffer = Buffer.alloc(0);
  let seen = 0;
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const len = readVarInt(buffer, 0);
      if (!len) return;
      if (buffer.length < len.offset + len.value) return;
      buffer = buffer.subarray(len.offset + len.value);
      seen++;
      if (seen === 2) {
        socket.write(buildStatusPacket());
        console.log(`[mock] 已响应状态查询（${names.length} 名玩家：${names.join(', ')}）`);
      }
    }
  });
  socket.on('error', () => {});
});

function runHeartbeat(port, label) {
  console.log('\n================ ' + label + ' ================');
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-DryRun', '-ServerHost', targetHost, '-ServerPort', String(port),
    '-LogFile', path.join(projectRoot, 'scripts', 'test-heartbeat.log')
  ];
  console.log('命令： powershell ' + args.join(' '));
  const r = spawnSync('powershell.exe', args, { stdio: 'inherit' });
  console.log('退出码：' + r.status);
  return r.status;
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`假 MC 服务器已启动：0.0.0.0:${PORT}（玩家 ${names.join(', ')}，本机局域网地址 ${lanAddress() || '无'}）`);
  console.log(`本次测试目标地址：${targetHost}:${PORT}`);

  const onlineCode = runHeartbeat(PORT, '测试 1：服务器在线');
  const offlineCode = runHeartbeat(DEAD_PORT, '测试 2：服务器离线');

  console.log('\n================ 结果 ================');
  console.log('在线分支退出码：' + onlineCode + '（期望 0）');
  console.log('离线分支退出码：' + offlineCode + '（期望 0）');

  sockets.forEach((s) => s.destroy());
  server.close(() => {
    const ok = onlineCode === 0 && offlineCode === 0;
    console.log(ok ? '脚本执行完毕 ✅（请人工确认上面在线分支是否为 UP 且玩家名正确）' : '存在失败 ❌');
    process.exit(ok ? 0 : 1);
  });
});
