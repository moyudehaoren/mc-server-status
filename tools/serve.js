// 本地预览用的静态服务器（看状态页面长什么样）
//
// 用法：
//   node tools/serve.js          # 默认 http://127.0.0.1:8080
//   node tools/serve.js 9000
//
// 然后用浏览器打开 http://127.0.0.1:8080 即可。
// 注意：必须用 HTTP 打开，直接双击 index.html（file://）会因浏览器安全策略
// 无法读取 status.json。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const port = Number(process.argv[2] || 8080);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(root, rel);

  // 防目录穿越
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`本地预览： http://127.0.0.1:${port}`);
  console.log(`根目录：   ${root}`);
  console.log('Ctrl+C 退出');
});
