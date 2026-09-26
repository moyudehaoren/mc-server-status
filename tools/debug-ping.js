// 调试用：起一个只会打印收到字节的 TCP 服务器，然后跑心跳脚本，
// 用来确认 PowerShell 端的 Minecraft 协议封包是否正确。
//
// 用法： node tools/debug-ping.js

const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(projectRoot, 'scripts', 'update_status.ps1');
const PORT = 25567;

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

const server = net.createServer((socket) => {
  console.log('[server] 有连接进来');
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    console.log(`[server] 收到 ${chunk.length} 字节: ${chunk.toString('hex')}`);
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const len = readVarInt(buffer, 0);
      if (!len) { console.log('[server] 等待更多数据（包长度还没读全）'); return; }
      const total = len.offset + len.value;
      console.log(`[server] 解析到包：长度=${len.value}，已收到=${buffer.length}，需要=${total}`);
      if (buffer.length < total) { console.log('[server] 包不完整，继续等'); return; }
      const packet = buffer.subarray(len.offset, total);
      console.log(`[server] 包体 hex: ${packet.toString('hex')}`);
      console.log(`[server] 包 ID: ${packet[0]}`);
      buffer = buffer.subarray(total);
    }
  });

  socket.on('error', (e) => console.log('[server] socket 错误：' + e.message));
  socket.on('close', () => console.log('[server] 连接关闭'));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] 监听 127.0.0.1:${PORT}`);
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-DryRun', '-ServerPort', String(PORT), '-TimeoutMs', '4000',
    '-LogFile', path.join(projectRoot, 'scripts', 'debug-ping.log')
  ], { stdio: 'inherit' });
  console.log('[test] 心跳脚本退出码：' + r.status);
  server.close(() => console.log('[server] 已停止'));
});
