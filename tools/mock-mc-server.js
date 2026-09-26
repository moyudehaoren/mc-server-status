// 假 Minecraft 服务器：只实现 Server List Ping 协议，用来在没开游戏时测试心跳脚本。
//
// 用法：
//   node tools/mock-mc-server.js [端口] [玩家名,逗号分隔]
//   node tools/mock-mc-server.js 25566 Steve,Alex,Notch
//
// 然后用另一终端运行：
//   powershell -ExecutionPolicy Bypass -File scripts/update_status.ps1 -DryRun -ServerPort 25566

const net = require('node:net');

const port = Number(process.argv[2] || 25566);
const names = (process.argv[3] || 'Steve,Alex').split(',').map((s) => s.trim()).filter(Boolean);

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
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return null;              // 数据还不够
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('VarInt too long');
  }
  return { value: result >>> 0, offset: pos };
}

function buildStatusPacket() {
  const status = {
    version: { name: '1.21.4', protocol: 767 },
    players: {
      max: 20,
      online: names.length,
      sample: names.map((name) => ({ name, id: '00000000-0000-0000-0000-000000000000' }))
    },
    description: { text: 'Mock Minecraft Server (测试用，不是真服务器)' }
  };
  const json = Buffer.from(JSON.stringify(status), 'utf8');
  const body = Buffer.concat([Buffer.from([0x00]), writeVarInt(json.length), json]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let packetsSeen = 0;

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const len = readVarInt(buffer, 0);
      if (!len) return;                                   // 等更多数据
      if (buffer.length < len.offset + len.value) return;  // 整包还没到齐
      const packet = buffer.subarray(len.offset, len.offset + len.value);
      buffer = buffer.subarray(len.offset + len.value);
      packetsSeen++;
      // 第 1 个包是 handshake，第 2 个包是 status request
      if (packetsSeen === 2) {
        socket.write(buildStatusPacket());
        console.log(`[mock] 已响应状态查询（${names.length} 名玩家：${names.join(', ')}）`);
      }
    }
  });

  socket.on('error', () => { /* 忽略客户端中断 */ });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock] 假 MC 服务器已监听 127.0.0.1:${port}，玩家：${names.join(', ')}`);
  console.log('[mock] Ctrl+C 退出');
});
