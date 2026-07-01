// 达芬奇密码 - 服务器（静态文件 + WebSocket 联机）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const PORT = process.env.PORT || 3456;

// ==================== 静态文件服务 ====================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const httpServer = http.createServer((req, res) => {
  let urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  urlPath = decodeURIComponent(urlPath);

  // 安全：防止目录遍历
  urlPath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(ROOT, urlPath);

  // 确保在 ROOT 内
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found: ' + urlPath);
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ==================== WebSocket 服务 ====================
const wss = new WebSocketServer({ noServer: true });

// 引入联机模块
const MessageRouter = require('../server/message-router.js');
const router = new MessageRouter();

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`[连接] 新客户端: ${clientIP}`);

  ws.on('message', (data) => {
    try {
      router.handleMessage(ws, data.toString());
    } catch (e) {
      console.error('[错误] 消息处理异常:', e.message);
      try { ws.send(JSON.stringify({ type: 'error', message: '服务器内部错误' })); } catch (_) {}
    }
  });

  ws.on('close', () => {
    console.log(`[断开] 客户端: ${clientIP}`);
    try {
      router.handleDisconnect(ws);
    } catch (e) {
      console.error('[错误] 断线处理异常:', e.message);
    }
  });

  ws.on('error', (e) => {
    console.error('[错误] WebSocket:', e.message);
  });

  // 发送欢迎消息
  ws.send(JSON.stringify({ type: 'connected', message: '已连接到服务器' }));
});

// HTTP → WebSocket 升级
httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ==================== 启动 ====================
httpServer.listen(PORT, () => {
  console.log('═══════════════════════════════════════');
  console.log('  🔐 达芬奇密码 · 在线桌游');
  console.log(`  本地访问: http://localhost:${PORT}`);
  console.log(`  局域网:   http://<你的IP>:${PORT}`);
  console.log('  联机对战已就绪 ✓');
  console.log('═══════════════════════════════════════');
});
