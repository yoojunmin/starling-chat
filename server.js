const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 8080;
const PAGE = path.join(__dirname, 'index.html');
const clients = new Set();
const history = [];
const MAX_HISTORY = 100;
const MAX_MESSAGE = 500;

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function publish(event, data) {
  const packet = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(packet);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 12000) { reject(new Error('too_large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/') {
    fs.readFile(PAGE, (err, html) => err ? send(res, 500, 'index.html을 읽을 수 없습니다.') : send(res, 200, html, 'text/html; charset=utf-8'));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/message') {
    try {
      const body = await readBody(req);
      const name = String(body.name || '').trim().replace(/[<>]/g, '').slice(0, 24);
      const text = String(body.text || '').trim().slice(0, MAX_MESSAGE);
      if (!name || !text) return send(res, 400, '닉네임과 메시지를 입력해 주세요.');
      const message = { id: crypto.randomUUID(), name, text, time: Date.now() };
      history.push(message);
      if (history.length > MAX_HISTORY) history.shift();
      publish('message', message);
      return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
    } catch (err) {
      return send(res, err.message === 'too_large' ? 413 : 400, '요청을 확인해 주세요.');
    }
  }
  send(res, 404, 'Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Starling Chat is running at http://localhost:${PORT}`);
  console.log('같은 Wi-Fi의 다른 기기는 이 컴퓨터의 로컬 IP 주소와 포트 8080으로 접속할 수 있습니다.');
});
