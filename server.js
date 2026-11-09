const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 8080;
const PAGE = path.join(__dirname, 'index.html');
const clients = new Set();
const history = [];
const media = new Map();
const MAX_HISTORY = 100;
const MAX_MESSAGE = 500;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
let mediaBytes = 0;

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function publish(event, data) {
  const packet = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const client of clients) {
    if (!client.destroyed) client.write(packet);
  }
}

function readBody(req, maxBytes = 12000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        reject(new Error('too_large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function cleanFileName(value) {
  const name = path.basename(String(value || 'image')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 100);
  return name || 'image';
}

function rememberMedia(buffer, type, name) {
  while (mediaBytes + buffer.length > MAX_MEDIA_BYTES && media.size) {
    const oldestId = media.keys().next().value;
    const oldest = media.get(oldestId);
    media.delete(oldestId);
    mediaBytes -= oldest.buffer.length;
  }
  const id = crypto.randomUUID();
  const item = { id, buffer, type, name };
  media.set(id, item);
  mediaBytes += buffer.length;
  return item;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(PAGE, (err, html) => err
      ? send(res, 500, 'index.html을 읽을 수 없습니다.')
      : send(res, 200, html, 'text/html; charset=utf-8'));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('event: history\ndata: ' + JSON.stringify(history) + '\n\n');
    clients.add(res);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': ping\n\n');
    }, 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
    const id = url.pathname.slice('/media/'.length);
    const item = media.get(id);
    if (!item) return send(res, 404, '이미지를 찾을 수 없습니다.');
    res.writeHead(200, {
      'Content-Type': item.type,
      'Content-Length': item.buffer.length,
      'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(item.name),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(item.buffer);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/upload') {
    try {
      const body = await readBody(req, 7 * 1024 * 1024);
      const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(body.data || ''));
      if (!match || !MIME_TYPES.has(match[1])) return send(res, 415, 'JPG, PNG, GIF, WEBP 이미지만 올릴 수 있습니다.');
      const buffer = Buffer.from(match[2], 'base64');
      if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return send(res, 413, '사진은 5MB 이하로 올려 주세요.');
      const item = rememberMedia(buffer, match[1], cleanFileName(body.name));
      return send(res, 200, JSON.stringify({ id: item.id, url: '/media/' + item.id, name: item.name }), 'application/json; charset=utf-8');
    } catch (err) {
      return send(res, err.message === 'too_large' ? 413 : 400, '사진 업로드 요청을 확인해 주세요.');
    }
  }

  if (req.method === 'POST' && url.pathname === '/message') {
    try {
      const body = await readBody(req);
      const name = String(body.name || '').trim().replace(/[<>]/g, '').slice(0, 24);
      const text = String(body.text || '').trim().slice(0, MAX_MESSAGE);
      const attachment = body.mediaId ? media.get(String(body.mediaId)) : null;
      if (!name || (!text && !attachment)) return send(res, 400, '닉네임과 메시지 또는 사진을 입력해 주세요.');
      if (body.mediaId && !attachment) return send(res, 410, '사진 업로드가 만료되었습니다. 다시 첨부해 주세요.');
      const message = {
        id: crypto.randomUUID(),
        name,
        text,
        time: Date.now(),
        ...(attachment ? { media: '/media/' + attachment.id, mediaName: attachment.name } : {})
      };
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
  console.log('Starling Chat is running on port ' + PORT);
});
