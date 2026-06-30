// 简单的静态文件服务器 - 达芬奇密码
var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var PORT = 3456;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

var server = http.createServer(function(req, res) {
  var urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  urlPath = decodeURIComponent(urlPath);
  var filePath = path.join(ROOT, urlPath);

  var ext = path.extname(filePath).toLowerCase();
  var mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, function(err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found: ' + urlPath);
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, function() {
  console.log('Server running at http://localhost:' + PORT);
});
