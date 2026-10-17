/* 本地回归测试服务器
 * 用法：node tests/serve.mjs  然后访问 http://127.0.0.1:8899/22748536
 * 目的：在真实 DOM 上验证 content.js 的定位、渲染与全屏迁移逻辑。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8899;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png'
};

http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);

  // 用房间号当路径，让 content.js 认为自己在直播间里
  if (p === '/' || /^\/\d{1,12}$/.test(p)) {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(fs.readFileSync(path.join(ROOT, 'tests/mock-live.html')));
    return;
  }

  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log('mock live page: http://127.0.0.1:' + PORT + '/22748536');
});
