const express  = require('express');
const fs        = require('fs');
const path      = require('path');
const archiver  = require('archiver');
const crypto    = require('crypto');
const http      = require('http');
const net       = require('net');
const { spawn } = require('child_process');
const multer    = require('multer');
const WebSocket = require('ws');

// ═══════════════════════════════════════════════
//  설정
// ═══════════════════════════════════════════════
const PORT     = 8080;
const PROXY_IP = '12.23.67.62';

const ADMIN_ID = 'admin';
const ADMIN_PW = '!!@@password';
const BOUNDARY = 'ffmpegstream';

const FFMPEG_PATH = 'C:\\ffmpeg\\bin\\ffmpeg.exe';

// 30초 내 첫 프레임 없음 → hung
// 60초간 프레임 없음 → hung
const HUNG_START_MS    = 30000;
const HUNG_NO_FRAME_MS = 60000;

// ═══════════════════════════════════════════════
//  디렉토리 초기화
// ═══════════════════════════════════════════════
const DATA_DIR  = path.join(__dirname, 'data');
const MEDIA_DIR = path.join(__dirname, 'media', 'library');
[DATA_DIR, MEDIA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const CAMERAS_FILE   = path.join(DATA_DIR, 'cameras.json');
const DISPLAYS_FILE  = path.join(DATA_DIR, 'displays.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');
const LOG_FILE       = path.join(DATA_DIR, 'cms.log');

// ═══════════════════════════════════════════════
//  인메모리 상태
// ═══════════════════════════════════════════════
const sessions        = new Set();                // 세션 토큰
const cameraProcesses = new Map();                // camName → FFmpeg 엔트리
const channelClients  = new Map();                // channelId → Set<ws>

// ═══════════════════════════════════════════════
//  데이터 헬퍼
// ═══════════════════════════════════════════════
function loadJson(file, defaultVal) {
  if (!fs.existsSync(file)) return defaultVal;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return defaultVal; }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const loadCameras   = () => loadJson(CAMERAS_FILE,   { cameras: [] });
const saveCameras   = d  => saveJson(CAMERAS_FILE,   d);
const loadDisplays  = () => loadJson(DISPLAYS_FILE,  { displays: [] });
const saveDisplays  = d  => saveJson(DISPLAYS_FILE,  d);
const loadSchedules = () => loadJson(SCHEDULES_FILE, { channels: [] });
const saveSchedules = d  => saveJson(SCHEDULES_FILE, d);

// ═══════════════════════════════════════════════
//  구조화 로그
// ═══════════════════════════════════════════════
const LOG_ROTATE_MS = 30 * 24 * 60 * 60 * 1000;
let logStartTime = null;

function getLogStartTime() {
  if (logStartTime) return logStartTime;
  try {
    const first = fs.readFileSync(LOG_FILE, 'utf8').split('\n')[0];
    if (first) { logStartTime = new Date(JSON.parse(first).ts).getTime(); return logStartTime; }
  } catch {}
  logStartTime = Date.now();
  return logStartTime;
}

// category: stream | control | schedule | system
function slog(event, data, category = 'system') {
  const line = JSON.stringify({ ts: new Date().toISOString(), category, event, ...data });
  try {
    if (Date.now() - getLogStartTime() > LOG_ROTATE_MS) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
      logStartTime = Date.now();
    }
  } catch {}
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ═══════════════════════════════════════════════
//  인증 헬퍼
// ═══════════════════════════════════════════════
function parseCookies(req) {
  const c = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const [k, ...v] = p.trim().split('=');
    if (k) c[k.trim()] = v.join('=').trim();
  });
  return c;
}
function isAuthenticated(req) {
  const c = parseCookies(req);
  return c.session && sessions.has(c.session);
}
function authMiddleware(req, res, next) {
  if (req.path === '/login') return next();
  if (!isAuthenticated(req)) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '인증이 필요합니다' });
    return res.redirect('/login');
  }
  next();
}

// ═══════════════════════════════════════════════
//  Multer — 미디어 업로드
// ═══════════════════════════════════════════════
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

const storage = multer.diskStorage({
  destination: MEDIA_DIR,
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8')
      .replace(/[^\w가-힣.\-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, VIDEO_EXTS.has(ext) || IMAGE_EXTS.has(ext));
  }
});

// ═══════════════════════════════════════════════
//  FFmpeg — RTSP → MJPEG (05 계승)
// ═══════════════════════════════════════════════
function startCameraStream(cam) {
  const rtspUrl = `rtsp://${cam.user}:${cam.pass}@${cam.host}:554/profile2/media.smp`;
  const startMs = Date.now();

  const ffmpeg = spawn(FFMPEG_PATH, [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-vf', 'scale=1080:960',
    '-r', '10',
    '-q:v', '8',
    '-f', 'mjpeg',
    '-'
  ], { windowsHide: true });

  const entry = {
    ffmpeg,
    clients: new Map(),
    buffer: Buffer.alloc(0),
    frameCount: 0,
    startMs,
    firstFrameMs: null,
    lastFrameAt: null,
    lastFrame: null,
    stderrLines: []
  };
  cameraProcesses.set(cam.name, entry);
  slog('stream_ffmpeg_start', { camera: cam.name, host: cam.host }, 'stream');

  ffmpeg.stdout.on('data', chunk => {
    entry.buffer = Buffer.concat([entry.buffer, chunk]);
    while (true) {
      const s = entry.buffer.indexOf(Buffer.from([0xFF, 0xD8]));
      const e = entry.buffer.indexOf(Buffer.from([0xFF, 0xD9]), s + 2);
      if (s === -1 || e === -1) break;
      const frame = entry.buffer.slice(s, e + 2);
      entry.buffer = entry.buffer.slice(e + 2);
      entry.frameCount++;
      const now = Date.now();
      if (entry.firstFrameMs === null) {
        entry.firstFrameMs = now - startMs;
        slog('stream_first_frame', { camera: cam.name, firstFrameMs: entry.firstFrameMs }, 'stream');
      }
      entry.lastFrameAt = now;
      entry.lastFrame = frame;
      for (const [res] of entry.clients) {
        try {
          res.write(`--${BOUNDARY}\r\n`);
          res.write('Content-Type: image/jpeg\r\n');
          res.write(`Content-Length: ${frame.length}\r\n\r\n`);
          res.write(frame);
          res.write('\r\n');
        } catch { removeClient(cam.name, res, 'write_error'); }
      }
    }
  });

  ffmpeg.stderr.on('data', chunk => {
    const line = chunk.toString().trim();
    if (!line) return;
    entry.stderrLines.push(line);
    if (entry.stderrLines.length > 5) entry.stderrLines.shift();
    if (/Connection refused|No route to host|Unauthorized|Invalid data|connection timeout|method\s+\w+\s+failed/i.test(line)) {
      const m = line.match(/failed:\s*(\d+)/i);
      const code = m ? parseInt(m[1]) : null;
      slog('ffmpeg_rtsp_error', { camera: cam.name, host: cam.host, code, line }, 'stream');
      if (code === 401 || code === 490) {
        const reason = code === 490 ? 'account_blocked' : 'unauthorized';
        slog('ffmpeg_rtsp_fatal', { camera: cam.name, code, reason }, 'stream');
        try { entry.ffmpeg.kill('SIGTERM'); } catch {}
      }
    }
  });

  ffmpeg.on('error', err => {
    slog('ffmpeg_spawn_error', { camera: cam.name, error: err.message }, 'stream');
  });

  ffmpeg.on('exit', (code, signal) => {
    const uptimeMs = Date.now() - startMs;
    const lastFrameAgoMs = entry.lastFrameAt ? Date.now() - entry.lastFrameAt : null;
    slog('ffmpeg_exit', {
      camera: cam.name, uptimeMs, frameCount: entry.frameCount,
      firstFrameMs: entry.firstFrameMs, lastFrameAgoMs, code, signal,
      stderrTail: entry.stderrLines.slice(-2)
    }, 'stream');
    cameraProcesses.delete(cam.name);
    for (const [res] of entry.clients) { try { res.end(); } catch {} }
  });

  return entry;
}

function removeClient(camName, res, reason) {
  const entry = cameraProcesses.get(camName);
  if (!entry || !entry.clients.has(res)) return;
  const connectMs = entry.clients.get(res);
  entry.clients.delete(res);
  slog('stream_disconnect', {
    camera: camName, uptimeMs: Date.now() - connectMs,
    frameCount: entry.frameCount, reason, clientsLeft: entry.clients.size
  }, 'stream');
}

// ═══════════════════════════════════════════════
//  Samsung MDC — TCP 1515 제어
// ═══════════════════════════════════════════════
function mdcChecksum(bytes) {
  return bytes.reduce((s, b) => (s + b) & 0xFF, 0);
}

function mdcPacket(cmd, id, data) {
  const body = [cmd, id, data.length, ...data];
  return Buffer.from([0xAA, ...body, mdcChecksum(body)]);
}

const MDC_INPUT = {
  hdmi1: 0x21, hdmi2: 0x23, dp: 0x25, dvi: 0x18, pc: 0x14
};

function sendMDC(ip, packet) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.connect(1515, ip, () => {
      sock.write(packet);
      sock.on('data', d => { sock.destroy(); resolve(d); });
      sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
    });
    sock.on('error', reject);
  });
}

async function mdcControl(ip, action, value) {
  let packet;
  switch (action) {
    case 'power_on':  packet = mdcPacket(0x11, 0x01, [0x01]); break;
    case 'power_off': packet = mdcPacket(0x11, 0x01, [0x00]); break;
    case 'input':     packet = mdcPacket(0x14, 0x01, [MDC_INPUT[value] || 0x21]); break;
    case 'volume':    packet = mdcPacket(0x12, 0x01, [Math.max(0, Math.min(100, parseInt(value) || 0))]); break;
    case 'mute_on':   packet = mdcPacket(0x13, 0x01, [0x01]); break;
    case 'mute_off':  packet = mdcPacket(0x13, 0x01, [0x00]); break;
    default: throw new Error('알 수 없는 MDC 액션');
  }
  return sendMDC(ip, packet);
}

// ═══════════════════════════════════════════════
//  WebSocket — 채널별 플레이어 관리
// ═══════════════════════════════════════════════
function pushToChannel(channelId, payload) {
  const clients = channelClients.get(channelId);
  if (!clients || clients.size === 0) return 0;
  const msg = JSON.stringify(payload);
  let sent = 0;
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) { ws.send(msg); sent++; }
  }
  return sent;
}

function pushAllChannels() {
  const schedules = loadSchedules();
  for (const ch of schedules.channels) {
    pushToChannel(ch.id, { type: 'update', channel: ch.id, name: ch.name, items: ch.items });
  }
}

// ═══════════════════════════════════════════════
//  MagicInfo ZIP 생성 (05 계승)
// ═══════════════════════════════════════════════
function generateCctvHtml(cameras, serverIp, splitMode) {
  const cells = cameras.map(c => {
    const e = encodeURIComponent(c.name);
    return { name: c.name, src: `http://${serverIp}:${PORT}/stream/${e}` };
  });
  const idArr = JSON.stringify(cameras.map(c => c.name));

  const reconnectScript = `
(function(){
  var SERVER='http://${serverIp}:${PORT}';
  var IDS=${idArr};
  var MAX=5; var retry={};
  function poll(){
    fetch(SERVER+'/api/streams').then(function(r){return r.json();}).then(function(d){
      var active=d.active||[];
      IDS.forEach(function(id){
        var img=document.getElementById(id);
        if(!img)return;
        if(active.indexOf(id)===-1){
          retry[id]=(retry[id]||0)+1;
          if(retry[id]>MAX)return;
          setTimeout(function(){ img.src=SERVER+'/stream/'+encodeURIComponent(id)+'?_t='+Date.now(); },2000);
        } else { retry[id]=0; }
      });
    }).catch(function(){});
  }
  setInterval(poll,10000);
})();`;

  const onerror = `onerror="var s=this;setTimeout(function(){s.src=s.src.split('?')[0]+'?_t='+Date.now();},3000)"`;
  const overlay = `<div id="overlay" style="position:fixed;top:0;left:0;pointer-events:none;z-index:999;width:100%;height:100%;"><img src="overlay.png" style="width:100%;height:100%;display:block;" onerror="this.style.display='none'"/></div>`;

  if (splitMode === 1) {
    const c = cells[0];
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:1920px;height:1080px;background:#000;overflow:hidden}</style>
</head><body>
<img id="${c.name}" src="${c.src}" ${onerror} style="width:1920px;height:1080px;display:block;object-fit:fill;"/>
${overlay}<script>${reconnectScript}</script></body></html>`;
  }
  if (splitMode === 2) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:1080px;height:1920px;background:#000;overflow:hidden}
.grid{display:flex;flex-direction:column;width:1080px;height:1920px}.cell{flex:1;border-bottom:2px solid #222}.cell:last-child{border-bottom:none}
img{width:100%;height:100%;display:block;object-fit:fill}</style>
</head><body><div class="grid">
${cells.map(c=>`<div class="cell"><img id="${c.name}" src="${c.src}" ${onerror}/></div>`).join('\n')}
</div>${overlay}<script>${reconnectScript}</script></body></html>`;
  }
  // 4분할
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:1920px;height:1080px;background:#000;overflow:hidden}
.grid{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;width:1920px;height:1080px;gap:2px;background:#222}
.cell{overflow:hidden}img{width:100%;height:100%;display:block;object-fit:fill}</style>
</head><body><div class="grid">
${cells.map(c=>`<div class="cell"><img id="${c.name}" src="${c.src}" ${onerror}/></div>`).join('\n')}
</div>${overlay}<script>${reconnectScript}</script></body></html>`;
}

// ═══════════════════════════════════════════════
//  Express 앱 + HTTP 서버
// ═══════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws/player' });

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── 공개 엔드포인트 (인증 불필요) ───────────────

// MJPEG 스트림 (플레이어/MagicInfo용)
app.get('/stream/:camName([^/]+)', (req, res) => {
  const data = loadCameras();
  const cam  = data.cameras.find(c => c.name === req.params.camName);
  if (!cam) { res.writeHead(404); res.end('카메라 없음'); return; }

  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });

  let entry = cameraProcesses.get(cam.name);
  if (entry) {
    slog('stream_reuse', { camera: cam.name }, 'stream');
  } else {
    entry = startCameraStream(cam);
    slog('stream_connect', { camera: cam.name, host: cam.host }, 'stream');
  }
  entry.clients.set(res, Date.now());
  res.on('error', () => removeClient(cam.name, res, 'res_error'));
  req.on('close',  () => removeClient(cam.name, res, 'client_close'));

  if (entry.lastFrame) {
    try {
      res.write(`--${BOUNDARY}\r\n`);
      res.write('Content-Type: image/jpeg\r\n');
      res.write(`Content-Length: ${entry.lastFrame.length}\r\n\r\n`);
      res.write(entry.lastFrame);
      res.write('\r\n');
    } catch { removeClient(cam.name, res, 'write_error'); }
  }
});

// 활성 스트림 목록 (MagicInfo HTML 폴링용)
app.get('/api/streams', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ active: Array.from(cameraProcesses.keys()) });
});

// 미디어 파일 서빙 (플레이어용)
app.use('/media', express.static(MEDIA_DIR));

// 플레이어 앱 (QMC URL Launcher로 접근)
app.get('/player', (req, res) => {
  res.sendFile(path.join(__dirname, 'player', 'index.html'));
});

// 플레이어용 현재 스케줄 조회 (인증 없음)
app.get('/api/schedule/current', (req, res) => {
  const channelId = req.query.channel;
  const schedules = loadSchedules();
  const ch = schedules.channels.find(c => c.id === channelId);
  if (!ch) return res.status(404).json({ error: '채널 없음' });
  res.json({ channel: ch });
});

// ─── 인증 미들웨어 적용 ───────────────────────────
app.use(authMiddleware);

// 로그인
app.get('/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/');
  res.send(loginHtml(false));
});
app.post('/login', (req, res) => {
  const { id, pw } = req.body;
  if (id === ADMIN_ID && pw === ADMIN_PW) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.add(token);
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Strict`);
    return res.redirect('/');
  }
  res.send(loginHtml(true));
});
app.get('/logout', (req, res) => {
  const c = parseCookies(req);
  if (c.session) sessions.delete(c.session);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
  res.redirect('/login');
});

// 관리자 UI
app.use(express.static(path.join(__dirname, 'public')));

// ─── 미디어 라이브러리 API ─────────────────────────

app.get('/api/media', (req, res) => {
  const files = fs.readdirSync(MEDIA_DIR)
    .filter(f => !f.startsWith('.'))
    .map(name => {
      const stat = fs.statSync(path.join(MEDIA_DIR, name));
      const ext  = path.extname(name).toLowerCase();
      const type = VIDEO_EXTS.has(ext) ? 'video' : 'image';
      return { filename: name, type, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(files);
});

app.post('/api/media', upload.array('files', 20), (req, res) => {
  const uploaded = (req.files || []).map(f => ({
    filename: f.filename, type: VIDEO_EXTS.has(path.extname(f.filename).toLowerCase()) ? 'video' : 'image',
    size: f.size
  }));
  slog('media_upload', { files: uploaded.map(f => f.filename), count: uploaded.length }, 'system');
  res.json({ ok: true, files: uploaded });
});

app.delete('/api/media/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '파일 없음' });
  fs.unlinkSync(filepath);
  slog('media_delete', { filename }, 'system');
  res.json({ ok: true });
});

// ─── 스케줄 API ───────────────────────────────────

app.get('/api/schedules', (req, res) => {
  res.json(loadSchedules());
});

// 채널 생성
app.post('/api/schedules', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '채널명 필요' });
  const data = loadSchedules();
  const ch = { id: `ch_${crypto.randomBytes(4).toString('hex')}`, name: name.trim(), items: [] };
  data.channels.push(ch);
  saveSchedules(data);
  slog('schedule_channel_create', { id: ch.id, name: ch.name }, 'schedule');
  res.json(ch);
});

// 채널 수정 (이름 + 아이템 목록 전체 교체)
app.put('/api/schedules/:id', (req, res) => {
  const data = loadSchedules();
  const ch = data.channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: '채널 없음' });
  if (req.body.name  !== undefined) ch.name  = req.body.name.trim();
  if (req.body.items !== undefined) ch.items = req.body.items;
  saveSchedules(data);
  slog('schedule_channel_update', { id: ch.id }, 'schedule');
  // 연결된 플레이어에 즉시 푸시
  const sent = pushToChannel(ch.id, { type: 'update', channel: ch.id, name: ch.name, items: ch.items });
  res.json({ ok: true, pushed: sent });
});

// 채널 삭제
app.delete('/api/schedules/:id', (req, res) => {
  const data = loadSchedules();
  const idx  = data.channels.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '채널 없음' });
  const [removed] = data.channels.splice(idx, 1);
  saveSchedules(data);
  slog('schedule_channel_delete', { id: removed.id }, 'schedule');
  res.json({ ok: true });
});

// 즉시 푸시 (저장 없이 강제 전송)
app.post('/api/schedules/:id/push', (req, res) => {
  const data = loadSchedules();
  const ch   = data.channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: '채널 없음' });
  const sent = pushToChannel(ch.id, { type: 'update', channel: ch.id, name: ch.name, items: ch.items });
  slog('schedule_push', { id: ch.id, sent }, 'schedule');
  res.json({ ok: true, sent });
});

// ─── 디스플레이 API ───────────────────────────────

app.get('/api/displays', (req, res) => {
  res.json(loadDisplays());
});

app.post('/api/displays', (req, res) => {
  const { name, ip, location, channelId } = req.body;
  if (!name || !ip) return res.status(400).json({ error: '이름·IP 필요' });
  const data = loadDisplays();
  const d = {
    id: `d_${crypto.randomBytes(4).toString('hex')}`,
    name: name.trim(), ip: ip.trim(),
    location: (location || '').trim(),
    channelId: channelId || null,
    addedAt: new Date().toISOString()
  };
  data.displays.push(d);
  saveDisplays(data);
  slog('display_add', { id: d.id, name: d.name, ip: d.ip }, 'control');
  res.json(d);
});

app.put('/api/displays/:id', (req, res) => {
  const data = loadDisplays();
  const d = data.displays.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: '디스플레이 없음' });
  ['name', 'ip', 'location', 'channelId'].forEach(k => {
    if (req.body[k] !== undefined) d[k] = typeof req.body[k] === 'string' ? req.body[k].trim() : req.body[k];
  });
  saveDisplays(data);
  slog('display_update', { id: d.id }, 'control');
  res.json({ ok: true });
});

app.delete('/api/displays/:id', (req, res) => {
  const data = loadDisplays();
  const idx  = data.displays.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '디스플레이 없음' });
  const [removed] = data.displays.splice(idx, 1);
  saveDisplays(data);
  slog('display_remove', { id: removed.id, name: removed.name }, 'control');
  res.json({ ok: true });
});

// MDC 제어
app.post('/api/displays/:id/control', async (req, res) => {
  const { action, value } = req.body;
  const data = loadDisplays();
  const d    = data.displays.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: '디스플레이 없음' });
  try {
    await mdcControl(d.ip, action, value);
    slog('mdc_control', { displayId: d.id, name: d.name, ip: d.ip, action, value }, 'control');
    res.json({ ok: true });
  } catch (err) {
    slog('mdc_error', { displayId: d.id, ip: d.ip, action, error: err.message }, 'control');
    res.status(500).json({ error: err.message });
  }
});

// 그룹 제어 (채널에 연결된 모든 TV)
app.post('/api/displays/group/control', async (req, res) => {
  const { channelId, action, value } = req.body;
  const data = loadDisplays();
  const targets = data.displays.filter(d => d.channelId === channelId);
  const results = await Promise.allSettled(
    targets.map(d => mdcControl(d.ip, action, value)
      .then(() => { slog('mdc_control', { displayId: d.id, ip: d.ip, action, value }, 'control'); return { id: d.id, ok: true }; })
      .catch(err => { slog('mdc_error', { displayId: d.id, ip: d.ip, action, error: err.message }, 'control'); return { id: d.id, ok: false, error: err.message }; })
    )
  );
  res.json({ results: results.map(r => r.value || r.reason) });
});

// ─── CCTV 카메라 API (05 계승) ────────────────────

app.get('/api/cameras', (req, res) => {
  res.json(loadCameras());
});

app.post('/api/cameras', (req, res) => {
  const { name, host, user, pass } = req.body;
  if (!name || !host) return res.status(400).json({ error: '이름·호스트 필요' });
  if (!/^[\w가-힣]+$/.test(name)) return res.status(400).json({ error: '잘못된 카메라 이름' });
  const data = loadCameras();
  const dup  = data.cameras.find(c => c.host === host && c.user === user && c.pass === pass);
  if (dup) return res.json({ ok: true, camera: dup, reused: true });
  const cam = { name, host, user: user || 'admin', pass: pass || '' };
  data.cameras.push(cam);
  saveCameras(data);
  slog('camera_add', { name, host }, 'stream');
  res.json({ ok: true, camera: cam });
});

app.patch('/api/cameras/:name/password', (req, res) => {
  if (!/^[\w가-힣]+$/.test(req.params.name)) return res.status(400).json({ error: '잘못된 이름' });
  const { pass } = req.body;
  if (!pass || !pass.trim()) return res.status(400).json({ error: '비밀번호 필요' });
  const data = loadCameras();
  const cam  = data.cameras.find(c => c.name === req.params.name);
  if (!cam) return res.status(404).json({ error: '카메라 없음' });
  cam.pass = pass.trim();
  saveCameras(data);
  const entry = cameraProcesses.get(req.params.name);
  if (entry) {
    slog('stream_pw_changed', { camera: req.params.name }, 'stream');
    try { entry.ffmpeg.kill('SIGTERM'); } catch {}
  }
  res.json({ ok: true });
});

app.post('/api/streams/:name/restart', (req, res) => {
  if (!/^[\w가-힣]+$/.test(req.params.name)) return res.status(400).json({ error: '잘못된 이름' });
  const data = loadCameras();
  const cam  = data.cameras.find(c => c.name === req.params.name);
  if (!cam) return res.status(404).json({ error: '카메라 없음' });
  const existing = cameraProcesses.get(req.params.name);
  if (existing) {
    slog('stream_manual_restart', { camera: req.params.name }, 'stream');
    try { existing.ffmpeg.kill('SIGTERM'); } catch {}
  } else {
    startCameraStream(cam);
  }
  res.json({ ok: true });
});

app.delete('/api/cameras/:name', (req, res) => {
  if (!/^[\w가-힣]+$/.test(req.params.name)) return res.status(400).json({ error: '잘못된 이름' });
  const data = loadCameras();
  data.cameras = data.cameras.filter(c => c.name !== req.params.name);
  saveCameras(data);
  const entry = cameraProcesses.get(req.params.name);
  if (entry) {
    slog('stream_camera_deleted', { camera: req.params.name }, 'stream');
    try { entry.ffmpeg.kill('SIGTERM'); } catch {}
  }
  res.json({ ok: true });
});

// MagicInfo ZIP 생성
app.post('/api/generate', (req, res) => {
  const { cameras: newCameras, splitMode, images } = req.body;
  if (!newCameras || !Array.isArray(newCameras)) return res.status(400).json({ error: '요청 오류' });

  const data     = loadCameras();
  const existing = data.cameras || [];

  const resolvedCameras = newCameras.map(nc => {
    const dup = existing.find(ec => ec.host === nc.host && ec.user === nc.user && ec.pass === nc.pass);
    return dup ? { ...dup } : nc;
  });

  const updatedCameras = [...existing];
  for (const rc of resolvedCameras) {
    if (!updatedCameras.some(ec => ec.host === rc.host && ec.user === rc.user && ec.pass === rc.pass))
      updatedCameras.push(rc);
  }
  data.cameras = updatedCameras;
  saveCameras(data);

  const htmlContent = generateCctvHtml(resolvedCameras, PROXY_IP, splitMode);
  const htmlFilename = splitMode === 1 ? 'index.html' : splitMode === 2 ? 'index2.html' : 'index4.html';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="cctv_${Date.now()}.zip"`);

  const arc = archiver('zip', { zlib: { level: 9 } });
  arc.on('error', err => { if (!res.headersSent) res.status(500).end(); });
  arc.pipe(res);
  arc.append(htmlContent, { name: htmlFilename });
  if (images && images.overlay) arc.append(Buffer.from(images.overlay, 'base64'), { name: 'overlay.png' });
  arc.finalize();
});

// ─── 로그 API ──────────────────────────────────────

app.get('/api/logs', (req, res) => {
  const limit    = Math.min(parseInt(req.query.limit) || 200, 500);
  const category = req.query.category || 'all';
  if (!fs.existsSync(LOG_FILE)) return res.json([]);
  const entries = fs.readFileSync(LOG_FILE, 'utf8')
    .trim().split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter(l => category === 'all' || l.category === category);
  res.json(entries.slice(-limit).reverse());
});

// ─── 서버 정보 API ─────────────────────────────────

app.get('/api/server-info', (req, res) => {
  res.json({
    ip: PROXY_IP,
    port: PORT,
    uptime: process.uptime(),
    cameras: cameraProcesses.size,
    wsClients: [...channelClients.values()].reduce((s, c) => s + c.size, 0)
  });
});

// ═══════════════════════════════════════════════
//  WebSocket 처리
// ═══════════════════════════════════════════════
wss.on('connection', (ws, req) => {
  const url       = new URL(req.url, `http://localhost`);
  const channelId = url.searchParams.get('channel') || null;

  ws.channelId = channelId;

  if (channelId) {
    if (!channelClients.has(channelId)) channelClients.set(channelId, new Set());
    channelClients.get(channelId).add(ws);
    // 연결 즉시 현재 스케줄 전송
    const schedules = loadSchedules();
    const ch = schedules.channels.find(c => c.id === channelId);
    if (ch) ws.send(JSON.stringify({ type: 'update', channel: ch.id, name: ch.name, items: ch.items }));
    slog('ws_connect', { channelId, total: channelClients.get(channelId).size }, 'system');
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    } catch {}
  });

  ws.on('close', () => {
    if (channelId && channelClients.has(channelId)) {
      channelClients.get(channelId).delete(ws);
      slog('ws_disconnect', { channelId, remaining: channelClients.get(channelId).size }, 'system');
    }
  });
});

// ═══════════════════════════════════════════════
//  FFmpeg Hung 워치독 (05 계승)
// ═══════════════════════════════════════════════
setInterval(() => {
  const now = Date.now();
  for (const [camName, entry] of cameraProcesses) {
    if (entry.firstFrameMs === null) {
      if (now - entry.startMs > HUNG_START_MS) {
        slog('ffmpeg_hung_kill', { camera: camName, reason: 'no_first_frame', waitMs: now - entry.startMs }, 'stream');
        try { entry.ffmpeg.kill('SIGTERM'); } catch {}
      }
    } else {
      if (now - entry.lastFrameAt > HUNG_NO_FRAME_MS) {
        slog('ffmpeg_hung_kill', { camera: camName, reason: 'no_frame', noFrameMs: now - entry.lastFrameAt }, 'stream');
        try { entry.ffmpeg.kill('SIGTERM'); } catch {}
      }
    }
  }
}, 30000);

// ═══════════════════════════════════════════════
//  로그인 페이지 HTML
// ═══════════════════════════════════════════════
function loginHtml(error) {
  return `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>로그인 — CMS</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#fff;--surface:#f5f5f5;--border:#d0d0d0;--accent:#C9A227;--accent-h:#A8841A;--danger:#e05353;--text:#1a1a1a;--muted:#888}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI','Malgun Gothic',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:48px 40px;width:380px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:32px}
.logo h1{font-size:18px;font-weight:700}.logo .badge{background:var(--accent);color:#fff;font-size:11px;padding:2px 8px;border-radius:20px}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px}
.form-group input{width:100%;background:#fff;border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:15px;outline:none;transition:border-color .2s}
.form-group input:focus{border-color:var(--accent)}
.btn{width:100%;padding:14px;background:var(--accent);border:none;border-radius:10px;color:#fff;font-size:16px;font-weight:700;cursor:pointer;margin-top:8px;transition:background .2s}
.btn:hover{background:var(--accent-h)}
.err{background:#fef0f0;border:1px solid #fcc;border-radius:8px;color:var(--danger);font-size:14px;padding:10px 14px;margin-bottom:16px;text-align:center}
</style></head><body>
<div class="card">
  <div class="logo"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#C9A227" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg><h1>CMS</h1><span class="badge">관리자</span></div>
  ${error ? '<div class="err">아이디 또는 비밀번호가 올바르지 않습니다</div>' : ''}
  <form method="POST" action="/login">
    <div class="form-group"><label>아이디</label><input type="text" name="id" autofocus autocomplete="username"/></div>
    <div class="form-group"><label>비밀번호</label><input type="password" name="pw" autocomplete="current-password"/></div>
    <button type="submit" class="btn">로그인</button>
  </form>
</div></body></html>`;
}

// ═══════════════════════════════════════════════
//  프로세스 종료 처리
// ═══════════════════════════════════════════════
process.on('uncaughtException',  err => slog('uncaught_exception',  { error: err.message, stack: err.stack }, 'system'));
process.on('unhandledRejection', err => slog('unhandled_rejection', { error: String(err) }, 'system'));

function shutdownAll(signal) {
  slog('server_shutdown', { signal, ffmpegCount: cameraProcesses.size }, 'system');
  for (const [, entry] of cameraProcesses) { try { entry.ffmpeg.kill('SIGTERM'); } catch {} }
  process.exit(0);
}
process.on('SIGTERM', () => shutdownAll('SIGTERM'));
process.on('SIGINT',  () => shutdownAll('SIGINT'));

// ═══════════════════════════════════════════════
//  서버 시작
// ═══════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`CMS 서버 실행 중: http://localhost:${PORT}`);
  console.log(`플레이어 앱:       http://${PROXY_IP}:${PORT}/player?channel=<채널ID>`);
  console.log(`RTSP 프록시:      http://localhost:${PORT}/stream/<카메라명>`);
});
