const express  = require('express');
const fs        = require('fs');
const path      = require('path');
const archiver  = require('archiver');
const crypto    = require('crypto');
const http      = require('http');
const net       = require('net');
const dgram     = require('dgram');
const { spawn } = require('child_process');
const multer    = require('multer');
const WebSocket = require('ws');

// ═══════════════════════════════════════════════
//  설정
// ═══════════════════════════════════════════════
const PORT     = 8080;
const PROXY_IP = '12.23.67.245';
const MDC_ID   = 0x01; // 삼성 디스플레이 Device ID (현재 장비 설정값: 1)
const WOL_BROADCAST_IP = process.env.WOL_BROADCAST_IP || '255.255.255.255'; // 필요 시 예: 12.23.68.255

const ADMIN_ID = 'admin';
const ADMIN_PW = '!!@@password';
const BOUNDARY = 'ffmpegstream';

const FFMPEG_PATH = process.env.FFMPEG_PATH || (process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg');
const ENABLE_CCTV = process.env.ENABLE_CCTV === '1';

// 30초 내 첫 프레임 없음 → hung
// 60초간 프레임 없음 → hung
const HUNG_START_MS    = 30000;
const HUNG_NO_FRAME_MS = 60000;
const PLAYER_HEARTBEAT_STALE_MS = 35000;
const PLAYBACK_PROFILE_DEFAULT = 'balanced';
const STREAM_SYNC_LEAD_MS = 5000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2시간
const MDC_DIAG = process.env.MDC_DIAG === '1';

// ═══════════════════════════════════════════════
//  디렉토리 초기화
// ═══════════════════════════════════════════════
const DATA_DIR  = path.join(__dirname, 'data');
const MEDIA_DIR = path.join(__dirname, 'media', 'library');
[DATA_DIR, MEDIA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const CAMERAS_FILE   = path.join(DATA_DIR, 'cameras.json');
const DISPLAYS_FILE  = path.join(DATA_DIR, 'displays.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');
const CHANNELS_FILE  = path.join(DATA_DIR, 'channels.json');
const LOG_FILE       = path.join(DATA_DIR, 'cms.log');
const CCTV_CONTENT_FILE = path.join(DATA_DIR, 'cctv-contents.json');
const CCTV_ALLOWED_IPS_FILE = path.join(DATA_DIR, 'cctv-allowed-ips.json');
const WEB_CONTENT_FILE = path.join(DATA_DIR, 'web-contents.json');

// ═══════════════════════════════════════════════
//  인메모리 상태
// ═══════════════════════════════════════════════
const sessions        = new Map();                // 세션 토큰 -> { createdAt, expiresAt, lastSeenAt }
const cameraProcesses = new Map();                // camName → FFmpeg 엔트리
const channelClients  = new Map();                // channelId → Set<ws>
const mdcStatusCache  = new Map();                // ip → { power, volume, mute, input, ts }

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
const loadSchedules = () => loadJson(SCHEDULES_FILE, { channels: [], groups: [] });
const saveSchedules = d  => saveJson(SCHEDULES_FILE, d);
const loadChannels = () => loadJson(CHANNELS_FILE, { channels: [] });
const saveChannels = d => saveJson(CHANNELS_FILE, d);
const loadCctvContents = () => loadJson(CCTV_CONTENT_FILE, { items: [] });
const saveCctvContents = d => saveJson(CCTV_CONTENT_FILE, d);
const loadCctvAllowedIps = () => loadJson(CCTV_ALLOWED_IPS_FILE, { ips: [] });
const saveCctvAllowedIps = d => saveJson(CCTV_ALLOWED_IPS_FILE, d);

function normalizeClientIp(rawIp) {
  const ip = String(rawIp || '').trim();
  if (!ip) return '';
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function getRequestClientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const candidate = fwd || req.ip || req.socket?.remoteAddress || '';
  return normalizeClientIp(candidate);
}

function isClientIpAllowedForCctv(req) {
  const allowed = loadCctvAllowedIps();
  const list = Array.isArray(allowed.ips)
    ? allowed.ips.map(v => normalizeClientIp(v)).filter(Boolean)
    : [];
  // 호환 모드: 목록이 비어 있으면 기존처럼 허용
  if (!list.length) return true;
  const ip = getRequestClientIp(req);
  return !!ip && list.includes(ip);
}

function requireCctvIpAllowed(req, res, next) {
  if (isClientIpAllowedForCctv(req)) return next();
  return res.status(403).json({ error: '허용되지 않은 IP입니다' });
}
const loadWebContents = () => loadJson(WEB_CONTENT_FILE, { items: [] });
const saveWebContents = d => saveJson(WEB_CONTENT_FILE, d);

function getRequestBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `${PROXY_IP}:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function normalizePlaybackProfile(value) {
  const v = String(value || '').trim();
  if (v === 'stable' || v === 'balanced' || v === 'low_latency') return v;
  return PLAYBACK_PROFILE_DEFAULT;
}

function ensureDisplaysData() {
  const data = loadDisplays();
  data.displays = Array.isArray(data.displays) ? data.displays : [];
  let changed = false;
  for (const d of data.displays) {
    const normalized = normalizePlaybackProfile(d.playbackProfile);
    if (d.playbackProfile !== normalized) {
      d.playbackProfile = normalized;
      changed = true;
    }
  }
  if (changed) saveDisplays(data);
  return data;
}

function ensureSchedulesData() {
  const data = loadSchedules();
  data.channels = Array.isArray(data.channels) ? data.channels : [];
  data.groups = Array.isArray(data.groups) ? data.groups : [];
  let changed = false;

  for (const g of data.groups) {
    if (!g.id) {
      g.id = `sg_${crypto.randomBytes(4).toString('hex')}`;
      changed = true;
    }
    if (!g.name || !String(g.name).trim()) {
      g.name = '새 그룹';
      changed = true;
    }
  }
  const validGroupIds = new Set(data.groups.map(g => g.id));
  for (const ch of data.channels) {
    if (ch.groupId !== undefined && ch.groupId !== null && !validGroupIds.has(ch.groupId)) {
      ch.groupId = null;
      changed = true;
    }
    if (ch.groupId === undefined) {
      ch.groupId = null;
      changed = true;
    }
  }

  if (changed) saveSchedules(data);
  return data;
}

function ensureChannelsData() {
  const channelData = loadChannels();
  const schedulesData = loadSchedules();
  const scheduleById = new Map((schedulesData.channels || []).map(s => [s.id, s]));
  channelData.channels = Array.isArray(channelData.channels) ? channelData.channels : [];
  let changed = false;

  for (const ch of channelData.channels) {
    if (!ch.defaultColor || !/^#[0-9a-fA-F]{6}$/.test(String(ch.defaultColor))) {
      ch.defaultColor = '#5e81ac';
      changed = true;
    }
    if (!Array.isArray(ch.rules)) {
      ch.rules = [];
      changed = true;
    }
    for (const rule of ch.rules) {
      if (!rule.id) {
        rule.id = `rule_${crypto.randomBytes(4).toString('hex')}`;
        changed = true;
      }
      if (rule.enabled === undefined) {
        rule.enabled = true;
        changed = true;
      }
      if (rule.priority === undefined || Number.isNaN(parseInt(rule.priority, 10))) {
        rule.priority = 100;
        changed = true;
      } else {
        rule.priority = parseInt(rule.priority, 10);
      }
      if (!rule.createdAt) {
        rule.createdAt = new Date().toISOString();
        changed = true;
      }
      if (!rule.updatedAt) {
        rule.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (rule.repeatWeekly === undefined) {
        rule.repeatWeekly = false;
        changed = true;
      }
      if (!rule.section) {
        rule.section = rule.repeatWeekly ? 'weekly' : 'reserved';
        changed = true;
      }
      if (rule.name === undefined) {
        rule.name = '';
        changed = true;
      }
      if (!rule.color || !/^#[0-9a-fA-F]{6}$/.test(String(rule.color))) {
        rule.color = '#5e81ac';
        changed = true;
      }
      if (!Array.isArray(rule.weekdays)) {
        rule.weekdays = [];
        changed = true;
      }
      const linkedSchedule = scheduleById.get(rule.scheduleId);
      const derivedGroupId = linkedSchedule?.groupId || '';
      if (rule.scheduleGroupId === undefined || rule.scheduleGroupId === null) {
        rule.scheduleGroupId = derivedGroupId;
        changed = true;
      } else {
        const g = String(rule.scheduleGroupId || '').trim();
        if (!g && derivedGroupId) {
          rule.scheduleGroupId = derivedGroupId;
          changed = true;
        } else if (g !== rule.scheduleGroupId) {
          rule.scheduleGroupId = g;
          changed = true;
        }
      }
      if (rule.startTime === undefined) {
        rule.startTime = '';
        changed = true;
      }
      if (rule.endTime === undefined) {
        rule.endTime = '';
        changed = true;
      }
    }
  }

  if (changed) saveChannels(channelData);
  return channelData;
}

function syncScheduleItemsForWebContent(webId, fields = {}) {
  const data = loadSchedules();
  data.channels = Array.isArray(data.channels) ? data.channels : [];
  let changed = false;
  for (const schedule of data.channels) {
    schedule.items = Array.isArray(schedule.items) ? schedule.items : [];
    for (const item of schedule.items) {
      if (item?.type !== 'web' || item.filename !== webContentKey(webId)) continue;
      if (fields.label !== undefined && item.label !== fields.label) {
        item.label = fields.label;
        changed = true;
      }
      if (fields.webUrl !== undefined && item.webUrl !== fields.webUrl) {
        item.webUrl = fields.webUrl;
        changed = true;
      }
    }
  }
  if (changed) saveSchedules(data);
  return changed;
}

function parseTimeToSeconds(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = m[3] === undefined ? 0 : parseInt(m[3], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return null;
  return hh * 3600 + mm * 60 + ss;
}

function isRuleActiveNow(rule, nowMs = Date.now()) {
  if (!rule || !rule.scheduleId || rule.enabled === false) return false;

  if (rule.repeatWeekly) {
    const weekdays = Array.isArray(rule.weekdays)
      ? [...new Set(rule.weekdays.map(v => parseInt(v, 10)).filter(v => v >= 0 && v <= 6))]
      : [];
    if (!weekdays.length) return false;
    const startSec = parseTimeToSeconds(rule.startTime);
    const endSec = parseTimeToSeconds(rule.endTime);
    if (startSec === null || endSec === null) return false;

    const now = new Date(nowMs);
    const day = now.getDay(); // 0=Sun
    const prevDay = (day + 6) % 7;
    const second = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    if (startSec <= endSec) {
      return weekdays.includes(day) && second >= startSec && second <= endSec;
    }
    return (weekdays.includes(day) && second >= startSec)
      || (weekdays.includes(prevDay) && second <= endSec);
  }

  const startMs = rule.startAt ? new Date(rule.startAt).getTime() : -Infinity;
  const endMs = rule.endAt ? new Date(rule.endAt).getTime() : Infinity;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false;
  return nowMs >= startMs && nowMs <= endMs;
}

function normalizeRulesInput(rulesInput, schedules) {
  if (rulesInput === undefined) return undefined;
  if (!Array.isArray(rulesInput)) throw new Error('규칙 형식이 올바르지 않습니다');
  const validScheduleIds = new Set((schedules.channels || []).map(s => s.id));
  const nowIso = new Date().toISOString();
  return rulesInput.map(raw => {
    const scheduleId = String(raw.scheduleId || '').trim();
    if (!scheduleId || !validScheduleIds.has(scheduleId)) {
      throw new Error('규칙에 존재하지 않는 스케줄이 포함되어 있습니다');
    }
    const repeatWeekly = raw.repeatWeekly === true;
    const startAt = raw.startAt ? String(raw.startAt).trim() : '';
    const endAt = raw.endAt ? String(raw.endAt).trim() : '';
    const startTime = raw.startTime ? String(raw.startTime).trim() : '';
    const endTime = raw.endTime ? String(raw.endTime).trim() : '';
    const weekdays = Array.isArray(raw.weekdays)
      ? [...new Set(raw.weekdays.map(v => parseInt(v, 10)).filter(v => v >= 0 && v <= 6))].sort((a, b) => a - b)
      : [];
    const linkedSchedule = (schedules.channels || []).find(s => s.id === scheduleId);
    const rawGroupId = String(raw.scheduleGroupId || '').trim();
    const scheduleGroupId = rawGroupId || String(linkedSchedule?.groupId || '');

    if (repeatWeekly) {
      if (!weekdays.length) throw new Error('주간 반복 규칙은 요일을 최소 1개 이상 선택해야 합니다');
      const startSec = parseTimeToSeconds(startTime);
      const endSec = parseTimeToSeconds(endTime);
      if (startSec === null || endSec === null) {
        throw new Error('주간 반복 규칙은 시작/종료 시간을 HH:MM 또는 HH:MM:SS 형식으로 입력해야 합니다');
      }
      if (startSec === endSec) {
        throw new Error('주간 반복 규칙의 시작시간과 종료시간은 같을 수 없습니다');
      }
    } else {
      if (!startAt && !endAt) throw new Error('기간 규칙은 시작시간 또는 종료시간이 필요합니다');
      if (startAt && Number.isNaN(new Date(startAt).getTime())) throw new Error('규칙 시작시간 형식이 올바르지 않습니다');
      if (endAt && Number.isNaN(new Date(endAt).getTime())) throw new Error('규칙 종료시간 형식이 올바르지 않습니다');
      if (startAt && endAt && new Date(startAt).getTime() > new Date(endAt).getTime()) {
        throw new Error('규칙 시작시간이 종료시간보다 늦을 수 없습니다');
      }
    }
    return {
      id: raw.id ? String(raw.id) : `rule_${crypto.randomBytes(4).toString('hex')}`,
      name: String(raw.name || '').trim(),
      section: raw.section === 'weekly' || raw.section === 'reserved' ? raw.section : (repeatWeekly ? 'weekly' : 'reserved'),
      color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color || '')) ? String(raw.color) : '#5e81ac',
      scheduleId,
      scheduleGroupId,
      repeatWeekly,
      startAt: repeatWeekly ? '' : (startAt || ''),
      endAt: repeatWeekly ? '' : (endAt || ''),
      weekdays: repeatWeekly ? weekdays : [],
      startTime: repeatWeekly ? startTime : '',
      endTime: repeatWeekly ? endTime : '',
      priority: Number.isNaN(parseInt(raw.priority, 10)) ? 100 : parseInt(raw.priority, 10),
      enabled: raw.enabled !== false,
      createdAt: raw.createdAt || nowIso,
      updatedAt: nowIso
    };
  });
}

function resolveScheduleForChannelId(channelId) {
  if (!channelId) return null;
  const channels = ensureChannelsData().channels || [];
  const schedules = loadSchedules();
  const channel = channels.find(ch => ch.id === channelId);
  if (!channel) return null;

  const scheduleMap = new Map((schedules.channels || []).map(s => [s.id, s]));
  const nowMs = Date.now();
  const activeRules = (channel.rules || [])
    .filter(rule => isRuleActiveNow(rule, nowMs) && scheduleMap.has(rule.scheduleId))
    .sort((a, b) => {
      const p = (parseInt(b.priority, 10) || 0) - (parseInt(a.priority, 10) || 0);
      if (p !== 0) return p;
      const u = new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime();
      if (u !== 0) return u;
      return String(a.id).localeCompare(String(b.id));
    });

  if (activeRules.length > 0) {
    const selectedRule = activeRules[0];
    return {
      channel,
      schedule: scheduleMap.get(selectedRule.scheduleId),
      source: 'rule',
      rule: selectedRule,
      activeRules
    };
  }

  if (channel.scheduleId && scheduleMap.has(channel.scheduleId)) {
    return {
      channel,
      schedule: scheduleMap.get(channel.scheduleId),
      source: 'default',
      rule: null,
      activeRules: []
    };
  }
  return null;
}

function buildPlayerUpdatePayload(channelId) {
  const resolved = resolveScheduleForChannelId(channelId);
  if (!resolved) return { type: 'update', channel: channelId || null, name: null, items: [] };
  return {
    type: 'update',
    channel: resolved.channel.id,
    name: resolved.channel.name || resolved.schedule.name,
    scheduleId: resolved.schedule.id,
    scheduleSource: resolved.source,
    ruleId: resolved.rule ? resolved.rule.id : null,
    items: resolvePlayableScheduleItems(resolved.schedule.items || [])
  };
}

const MEDIA_GROUPS_FILE = path.join(DATA_DIR, 'media-groups.json');
const loadMediaGroups   = () => loadJson(MEDIA_GROUPS_FILE, { groups: [] });
const saveMediaGroups   = d  => saveJson(MEDIA_GROUPS_FILE, d);
const MEDIA_META_FILE = path.join(DATA_DIR, 'media-meta.json');
const loadMediaMeta   = () => loadJson(MEDIA_META_FILE, { items: {} });
const saveMediaMeta   = d  => saveJson(MEDIA_META_FILE, d);

function webContentKey(id) {
  return `web:${id}`;
}

function buildDesignerContentUrl(id) {
  return `/designer-content.html?id=${encodeURIComponent(id)}`;
}

function buildDesignerMediaUrl(filename) {
  return `/designer-content.html?media=${encodeURIComponent(filename)}`;
}

function isAllowedWebUrl(url) {
  const value = String(url || '').trim();
  const isExternalHttp = /^https?:\/\//i.test(value);
  const isInternalPath = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(\?[^\s#]*)?(#[^\s]*)?$/.test(value);
  return !!value && (isExternalHttp || isInternalPath);
}

function guessMediaType(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return VIDEO_EXTS.has(ext) ? 'video' : 'image';
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeDesignerSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').trim();
  if (type === 'media') {
    const filename = path.basename(String(raw.filename || '').trim());
    if (!filename) return null;
    return {
      type: 'media',
      filename,
      mediaType: guessMediaType(filename),
      label: String(raw.label || '').trim() || filename.replace(/^\d+_/, '')
    };
  }
  if (type === 'web') {
    const url = String(raw.url || '').trim();
    if (!isAllowedWebUrl(url)) return null;
    return {
      type: 'web',
      url,
      label: String(raw.label || '').trim() || '웹 콘텐츠'
    };
  }
  return null;
}

function normalizeDesignerPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const orientation = String(raw.orientation || '').trim() === 'portrait' ? 'portrait' : 'landscape';
  const splitValue = parseInt(raw.split, 10);
  const split = [1, 2, 3, 4].includes(splitValue) ? splitValue : 1;
  const rawPlacements = Array.isArray(raw.placements) ? raw.placements : [];
  const placements = rawPlacements.map((entry, idx) => {
    const x = clampNumber(entry?.x, 0, 1, 0);
    const y = clampNumber(entry?.y, 0, 1, 0);
    const w = clampNumber(entry?.w, 0.05, 1, 1);
    const h = clampNumber(entry?.h, 0.05, 1, 1);
    const source = normalizeDesignerSource(entry?.source);
    return {
      slot: idx + 1,
      x: Math.min(1 - 0.01, x),
      y: Math.min(1 - 0.01, y),
      w: Math.min(1 - x, w),
      h: Math.min(1 - y, h),
      fit: ['cover', 'contain', 'fill'].includes(String(entry?.fit || '').trim()) ? String(entry.fit).trim() : 'cover',
      focusX: clampNumber(entry?.focusX, 0, 100, 50),
      focusY: clampNumber(entry?.focusY, 0, 100, 50),
      zoom: clampNumber(entry?.zoom, 50, 250, 100),
      source
    };
  });
  if (!placements.length) return null;
  const hasSource = placements.some(p => !!p.source);
  if (!hasSource) return null;
  return {
    orientation,
    split,
    stageSize: {
      w: Math.round(clampNumber(raw?.stageSize?.w, 100, 4096, orientation === 'portrait' ? 540 : 960)),
      h: Math.round(clampNumber(raw?.stageSize?.h, 100, 4096, orientation === 'portrait' ? 960 : 540))
    },
    placements
  };
}

function resolvePlayableScheduleItems(items) {
  const meta = loadMediaMeta();
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!item || item.type === 'web') return item;
    const filename = path.basename(String(item.filename || '').trim());
    const mediaMeta = meta.items?.[filename];
    if (!mediaMeta?.designer) {
      if (mediaMeta?.label && !item.label) return { ...item, label: mediaMeta.label };
      return item;
    }
    return {
      ...item,
      type: 'web',
      webUrl: buildDesignerMediaUrl(filename),
      label: mediaMeta.label || item.label || filename.replace(/^\d+_/, ''),
      sourceFilename: filename,
      sourceType: item.type
    };
  });
}

function collectDesignerSourceFilenames() {
  const files = new Set();
  const webContents = loadWebContents();
  for (const entry of webContents.items || []) {
    if (entry?.kind !== 'designer' || !entry?.designer?.placements) continue;
    for (const placement of entry.designer.placements || []) {
      const source = placement?.source;
      if (!source || source.type !== 'media' || !source.filename) continue;
      files.add(path.basename(String(source.filename)));
    }
  }
  return files;
}

function collectDesignerSourceFilenamesFromPayload(designer) {
  const files = new Set();
  for (const placement of designer?.placements || []) {
    const source = placement?.source;
    if (!source || source.type !== 'media' || !source.filename) continue;
    files.add(path.basename(String(source.filename)));
  }
  return files;
}

function reconcileDesignerSourceMediaHiddenState() {
  const meta = loadMediaMeta();
  meta.items = meta.items || {};
  const designerSources = collectDesignerSourceFilenames();
  let changed = false;
  for (const [filename, itemMeta] of Object.entries(meta.items || {})) {
    const next = { ...(itemMeta || {}) };
    if (designerSources.has(filename)) {
      if (next.hidden !== true) {
        next.hidden = true;
        meta.items[filename] = next;
        changed = true;
      }
      continue;
    }
    if (next.hidden === true) {
      delete next.hidden;
      if (Object.keys(next).length) meta.items[filename] = next;
      else delete meta.items[filename];
      changed = true;
    }
  }
  for (const filename of designerSources) {
    const next = { ...(meta.items[filename] || {}) };
    if (next.hidden !== true) {
      next.hidden = true;
      meta.items[filename] = next;
      changed = true;
    }
  }
  if (changed) saveMediaMeta(meta);
  return { changed, hiddenFiles: [...designerSources] };
}

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

function slogReq(req, event, data, category = 'system') {
  slog(event, { actorIp: getRequestClientIp(req), ...(data || {}) }, category);
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
function createSessionToken() {
  const now = Date.now();
  return {
    token: crypto.randomBytes(32).toString('hex'),
    meta: { createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_TTL_MS }
  };
}
function touchSession(token) {
  const now = Date.now();
  const meta = sessions.get(token);
  if (!meta) return false;
  if (meta.expiresAt <= now) {
    sessions.delete(token);
    return false;
  }
  meta.lastSeenAt = now;
  meta.expiresAt = now + SESSION_TTL_MS;
  sessions.set(token, meta);
  return true;
}
function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, meta] of sessions) {
    if (!meta || meta.expiresAt <= now) sessions.delete(token);
  }
}
function isAuthenticated(req) {
  const c = parseCookies(req);
  if (!c.session) return false;
  return touchSession(c.session);
}
function authMiddleware(req, res, next) {
  if (req.path === '/login') return next();
  if (!isAuthenticated(req)) {
    res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '인증이 필요합니다' });
    return res.redirect('/login');
  }
  next();
}

function cctvFeatureGuard(req, res, next) {
  if (ENABLE_CCTV) return next();
  return res.status(410).json({ error: 'CCTV 기능이 비활성화되었습니다' });
}

// ═══════════════════════════════════════════════
//  Multer — 미디어 업로드
// ═══════════════════════════════════════════════
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

const storage = multer.diskStorage({
  destination: MEDIA_DIR,
  filename: (req, file, cb) => {
    // multer는 latin1로 파싱하므로 utf8로 재변환 시도, 실패 시 원본 사용
    let original = file.originalname;
    try { original = Buffer.from(file.originalname, 'latin1').toString('utf8'); } catch {}
    const safe = original.replace(/[^\w가-힣.\-]/g, '_');
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
const CCTV_GUARDED_PATHS = [
  '/stream',
  '/api/streams',
  '/api/cameras',
  '/api/cctv-contents',
  '/api/cctv-allowed-ips',
  '/api/generate',
  '/cctv/live'
];

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
  magicinfo: 0x20, webcms: 0x20, url_launcher: 0x20, tv: 0x00, hdmi1: 0x21, hdmi2: 0x23, dp: 0x25, dvi: 0x18, pc: 0x14
};
const MDC_INPUT_NAME = {
  0x00: 'TV', 0x14: 'PC', 0x18: 'DVI', 0x20: 'MagicInfo',
  0x21: 'HDMI 1', 0x23: 'HDMI 2', 0x25: 'DisplayPort'
};

// MDC GET 쿼리 — 응답 데이터 바이트를 반환
function mdcQuery(ip, cmd) {
  const body = [cmd, MDC_ID, 0x00];
  const pkt  = Buffer.from([0xAA, ...body, mdcChecksum(body)]);
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.connect(1515, ip, () => {
      slogMdcDiag({ phase: 'query_connect', ip, cmd: `0x${cmd.toString(16)}`, packet: hex(pkt) });
      sock.write(pkt);
      let buf = Buffer.alloc(0);
      sock.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        slogMdcDiag({ phase: 'query_data', ip, cmd: `0x${cmd.toString(16)}`, data: hex(chunk), total: hex(buf) });
        // 응답 구조: AA FF [id] [len] [ack/nack] [cmd] [data...] [cs]
        if (buf.length >= 6 && buf[0] === 0xAA && buf[1] === 0xFF) {
          const len = buf[3];
          if (buf.length >= 4 + len + 1) {
            sock.destroy();
            if (buf[4] === 0x41) resolve(buf.slice(6, 4 + len)); // ACK
            else reject(new Error('NACK'));
          }
        }
      });
      sock.on('timeout', () => {
        slogMdcDiag({ phase: 'query_timeout', ip, cmd: `0x${cmd.toString(16)}`, packet: hex(pkt) });
        sock.destroy(); reject(new Error('timeout'));
      });
    });
    sock.on('error', err => {
      slogMdcDiag({ phase: 'query_error', ip, cmd: `0x${cmd.toString(16)}`, error: err.message });
      reject(err);
    });
  });
}

function sendMDC(ip, packet, options = {}) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let settled = false;
    let wrote = false;
    let graceTimer = null;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      try { sock.destroy(); } catch {}
      if (err) reject(err);
      else resolve(data);
    };
    sock.setTimeout(3000);
    sock.connect(1515, ip, () => {
      wrote = true;
      slogMdcDiag({ phase: 'send_connect', ip, packet: hex(packet), allowNoReply: !!options.allowNoReply });
      sock.write(packet);
      slogMdcDiag({ phase: 'send_write', ip, packet: hex(packet) });
      if (options.allowNoReply) {
        graceTimer = setTimeout(() => finish(null, Buffer.alloc(0)), options.graceMs || 700);
      }
    });
    sock.on('data', d => {
      slogMdcDiag({ phase: 'send_data', ip, packet: hex(packet), data: hex(d) });
      finish(null, d);
    });
    sock.on('timeout', () => {
      slogMdcDiag({ phase: 'send_timeout', ip, packet: hex(packet), allowNoReply: !!options.allowNoReply });
      if (options.allowNoReply && wrote) return finish(null, Buffer.alloc(0));
      finish(new Error('timeout'));
    });
    sock.on('close', hadError => {
      slogMdcDiag({ phase: 'send_close', ip, packet: hex(packet), hadError: !!hadError, wrote });
      if (!hadError && options.allowNoReply && wrote) finish(null, Buffer.alloc(0));
    });
    sock.on('error', err => {
      slogMdcDiag({ phase: 'send_error', ip, packet: hex(packet), error: err.message });
      finish(err);
    });
  });
}

// ═══════════════════════════════════════════════
//  Wake-on-LAN — Magic Packet
// ═══════════════════════════════════════════════
function sendWolPacket(mac, targetIp = WOL_BROADCAST_IP) {
  const clean = mac.replace(/[:\-]/g, '');
  if (clean.length !== 12 || !/^[0-9a-fA-F]+$/.test(clean)) throw new Error('잘못된 MAC 주소 형식');
  const macBytes = [];
  for (let i = 0; i < 12; i += 2) macBytes.push(parseInt(clean.slice(i, i + 2), 16));
  const buf = Buffer.alloc(102);
  buf.fill(0xFF, 0, 6);
  for (let i = 1; i <= 16; i++) macBytes.forEach((b, j) => { buf[6 * i + j] = b; });
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', err => { try { sock.close(); } catch {} reject(err); });
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(buf, 0, buf.length, 9, targetIp, err => {
        try { sock.close(); } catch {}
        if (err) reject(err);
        else resolve({ targetIp, port: 9 });
      });
    });
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function hex(buf) {
  return Buffer.from(buf).toString('hex');
}

function slogMdcDiag(data) {
  if (!MDC_DIAG) return;
  slog('mdc_diag', data, 'control');
}

async function mdcControl(ip, action, value) {
  let packet;
  switch (action) {
    case 'power_on':  packet = mdcPacket(0x11, MDC_ID, [0x01]); break;
    case 'power_off': return sendMDC(ip, mdcPacket(0x11, MDC_ID, [0x00]), { allowNoReply: true, graceMs: 700 });
    case 'input':     packet = mdcPacket(0x14, MDC_ID, [MDC_INPUT[value] || 0x21]); break;
    case 'volume':    packet = mdcPacket(0x12, MDC_ID, [Math.max(0, Math.min(100, parseInt(value) || 0))]); break;
    case 'mute_on':   packet = mdcPacket(0x13, MDC_ID, [0x01]); break;
    case 'mute_off':  packet = mdcPacket(0x13, MDC_ID, [0x00]); break;
    case 'channel': {
      const ch = Math.max(1, Math.min(999, parseInt(value) || 1));
      packet = mdcPacket(0x04, MDC_ID, [Math.floor(ch / 256), ch % 256]); break;
    }
    default: throw new Error('알 수 없는 MDC 액션');
  }
  return sendMDC(ip, packet);
}

function getActivePlayerByIp(ip) {
  for (const [, entry] of activePlayers) {
    if (entry.ip === ip) return entry;
  }
  return null;
}

function getActivePlayerForDisplay(display) {
  if (!display) return null;
  const duid = String(display.duid || '').trim();
  if (duid && activePlayers.has(duid)) {
    return activePlayers.get(duid);
  }
  return getActivePlayerByIp(display.ip);
}

function makeStep(label, status, detail) {
  return { label, status, detail: detail || '', ts: Date.now() };
}

async function executeDisplayAction(display, action, value, options = {}) {
  const steps = [];
  const wolDelayMs = Math.max(1000, parseInt(options.wolDelayMs) || 8000);
  const result = {
    id: display.id,
    name: display.name,
    ip: display.ip,
    ok: false,
    action,
    steps
  };

  try {
    switch (action) {
      case 'schedule_play':
      case 'cms_reload': {
        steps.push(makeStep('대상 확인', 'info', '플레이어 연결 상태 확인'));
        const player = getActivePlayerForDisplay(display);
        if (player) {
          player.ws.send(JSON.stringify({ type: 'mode', mode: 'schedule' }));
          steps.push(makeStep('스케줄 재생', 'success', '플레이어를 스케줄 재생 모드로 전환'));
          slog('player_mode_schedule_cmd', { ip: display.ip, displayId: display.id, bulk: !!options.bulk, via: 'ws' }, 'control');
        } else {
          steps.push(makeStep('플레이어 오프라인', 'info', 'URL Launcher 입력 전환 후 재접속 대기'));
          try {
            await mdcControl(display.ip, 'input', 'webcms');
            steps.push(makeStep('입력 전환', 'success', 'URL Launcher(Web CMS) 전환 명령 전송'));
            steps.push(makeStep('재접속 대기', 'info', '잠시 후 플레이어가 온라인으로 복귀하면 스케줄이 자동 송출됩니다'));
            slog('player_mode_schedule_cmd', { ip: display.ip, displayId: display.id, bulk: !!options.bulk, via: 'mdc_input_fallback' }, 'control');
          } catch (mdcErr) {
            steps.push(makeStep('입력 전환', 'warning', `MDC 전환 실패: ${mdcErr.message}`));
            steps.push(makeStep('안내', 'warning', 'TV 리모컨에서 URL Launcher/Web CMS 앱으로 전환하면 스케줄 재생이 시작됩니다'));
            slog('player_mode_schedule_cmd', {
              ip: display.ip,
              displayId: display.id,
              bulk: !!options.bulk,
              via: 'mdc_input_fallback_failed',
              error: mdcErr.message
            }, 'control');
          }
        }
        break;
      }
      case 'streaming': {
        steps.push(makeStep('대상 확인', 'info', '플레이어 연결 상태 확인'));
        const player = getActivePlayerForDisplay(display);
        if (!player) throw new Error('플레이어가 온라인이 아닙니다');
        const streamUrl = String(value || '').trim();
        if (!streamUrl) throw new Error('스트리밍 URL이 필요합니다');
        const playbackProfile = normalizePlaybackProfile(display.playbackProfile);
        const targetEpochMs = Number.isFinite(options.streamSyncEpochMs)
          ? Math.round(options.streamSyncEpochMs)
          : null;
        player.ws.send(JSON.stringify({ type: 'mode', mode: 'streaming', url: streamUrl, playbackProfile, targetEpochMs }));
        if (targetEpochMs) {
          const remainMs = Math.max(0, targetEpochMs - Date.now());
          steps.push(makeStep('스트리밍 동기 대기', 'success', `목표시각까지 ${remainMs}ms 대기 후 재생 (${playbackProfile})`));
        } else {
          steps.push(makeStep('스트리밍 전환', 'success', `플레이어를 AVPlay 스트리밍 모드로 전환 (${playbackProfile})`));
        }
        slog('player_mode_streaming_cmd', {
          ip: display.ip,
          displayId: display.id,
          streamUrl,
          playbackProfile,
          targetEpochMs,
          bulk: !!options.bulk
        }, 'control');
        break;
      }
      case 'wol': {
        steps.push(makeStep('전원 켜기 준비', 'info', `MAC 주소 확인 · ${WOL_BROADCAST_IP}:9`));
        if (!display.mac) throw new Error('MAC 주소 미등록');
        const wolInfo = await sendWolPacket(display.mac);
        steps.push(makeStep('전원 켜기 전송', 'success', `매직 패킷 전송 완료 · ${wolInfo.targetIp}:${wolInfo.port}`));
        slog('wol_sent', { displayId: display.id, ip: display.ip, targetIp: wolInfo.targetIp, port: wolInfo.port, bulk: !!options.bulk }, 'control');
        break;
      }
      case 'tv_restart': {
        steps.push(makeStep('전원 OFF', 'info', 'MDC 전원 OFF 전송'));
        await mdcControl(display.ip, 'power_off');
        steps.push(makeStep('전원 OFF', 'success', 'TV 전원 OFF 완료'));
        slog('mdc_control', { displayId: display.id, name: display.name, ip: display.ip, action: 'power_off', bulk: !!options.bulk }, 'control');
        if (!display.mac) throw new Error('TV 재시작에는 MAC 주소가 필요합니다');
        steps.push(makeStep('대기', 'info', `${Math.round(wolDelayMs / 1000)}초 후 전원 켜기 전송`));
        await delay(wolDelayMs);
        const wolInfo = await sendWolPacket(display.mac);
        steps.push(makeStep('전원 켜기 전송', 'success', `TV 부팅 신호 전송 완료 · ${wolInfo.targetIp}:${wolInfo.port}`));
        slog('wol_sent', { displayId: display.id, ip: display.ip, targetIp: wolInfo.targetIp, port: wolInfo.port, restart: true, bulk: !!options.bulk }, 'control');
        break;
      }
      default: {
        steps.push(makeStep('명령 전송', 'info', `action=${action}`));
        await mdcControl(display.ip, action, value);
        steps.push(makeStep('명령 전송', 'success', 'MDC 명령 전송 완료'));
        slog('mdc_control', { displayId: display.id, name: display.name, ip: display.ip, action, value, bulk: !!options.bulk }, 'control');
        break;
      }
    }
    result.ok = true;
    result.status = 'success';
    return result;
  } catch (err) {
    steps.push(makeStep('오류', 'error', err.message));
    result.status = 'error';
    result.error = err.message;
    if (action === 'wol' || action === 'tv_restart') {
      slog('wol_error', { displayId: display.id, ip: display.ip, action, error: err.message, bulk: !!options.bulk }, 'control');
    } else if (action === 'cms_reload' || action === 'schedule_play' || action === 'streaming') {
      slog('player_mode_error', { displayId: display.id, ip: display.ip, action, error: err.message, bulk: !!options.bulk }, 'control');
    } else {
      slog('mdc_error', { displayId: display.id, ip: display.ip, action, error: err.message, bulk: !!options.bulk }, 'control');
    }
    return result;
  }
}

async function executeBatchAction(displays, action, value, options = {}) {
  const concurrency = Math.max(1, Math.min(20, parseInt(options.concurrency) || 5));
  const streamSyncEpochMs = action === 'streaming'
    ? Math.max(Date.now() + 1000, Math.round(Date.now() + (parseInt(options.streamSyncLeadMs, 10) || STREAM_SYNC_LEAD_MS)))
    : null;
  const results = [];
  for (let i = 0; i < displays.length; i += concurrency) {
    const chunk = displays.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(display => executeDisplayAction(display, action, value, {
        ...options,
        bulk: true,
        streamSyncEpochMs
      }))
    );
    results.push(...chunkResults);
  }
  return {
    action,
    value: value === undefined ? null : value,
    streamSyncEpochMs,
    requested: displays.length,
    summary: {
      success: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length
    },
    results
  };
}

async function executeActionSequence(display, commands, options = {}) {
  const sequence = Array.isArray(commands) ? commands.filter(cmd => cmd && cmd.action) : [];
  const steps = [];
  const result = {
    id: display.id,
    name: display.name,
    ip: display.ip,
    ok: false,
    action: 'sequence',
    steps,
    commandCount: sequence.length
  };
  if (!sequence.length) {
    result.error = '실행할 제어 항목이 없습니다';
    steps.push(makeStep('오류', 'error', result.error));
    return result;
  }
  const interDelayMs = Math.max(0, parseInt(options.interDelayMs) || 600);
  for (let i = 0; i < sequence.length; i++) {
    const cmd = sequence[i];
    steps.push(makeStep(`제어 ${i + 1}`, 'info', `${cmd.action}${cmd.value !== undefined && cmd.value !== null ? `=${cmd.value}` : ''}`));
    const single = await executeDisplayAction(display, cmd.action, cmd.value, options);
    steps.push(...single.steps);
    if (!single.ok) {
      result.error = single.error;
      result.status = 'error';
      return result;
    }
    if (i < sequence.length - 1 && interDelayMs > 0) {
      steps.push(makeStep('대기', 'info', `${Math.round(interDelayMs)}ms 후 다음 제어`));
      await delay(interDelayMs);
    }
  }
  result.ok = true;
  result.status = 'success';
  return result;
}

// ═══════════════════════════════════════════════
//  MDC 상태 폴링
// ═══════════════════════════════════════════════
async function pollMdcStatus(d) {
  const st = { ts: Date.now() };
  try {
    const pw = await mdcQuery(d.ip, 0x11);
    st.power = pw[0] === 0x01 ? 'on' : 'off';
    if (st.power === 'on') {
      try { st.volume = (await mdcQuery(d.ip, 0x12))[0]; } catch {}
      try { st.mute   = (await mdcQuery(d.ip, 0x13))[0] === 0x01; } catch {}
      try {
        const inp = (await mdcQuery(d.ip, 0x14))[0];
        st.input     = inp;
        st.inputName = MDC_INPUT_NAME[inp] || `0x${inp.toString(16)}`;
      } catch {}
    }
  } catch { st.power = 'offline'; }
  mdcStatusCache.set(d.ip, st);
}

function pollAllMdcStatus() {
  const data = loadDisplays();
  Promise.allSettled(data.displays.map(d => pollMdcStatus(d)));
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

function pushToDisplaysByChannelId(channelId, payload) {
  const displays = loadDisplays().displays || [];
  const msg = JSON.stringify(payload);
  let sent = 0;
  for (const [duid, player] of activePlayers) {
    const dInfo = displays.find(d => String(d.duid || '').trim() === duid) || displays.find(d => d.ip === player.ip);
    if (dInfo && dInfo.channelId === channelId && player.ws?.readyState === WebSocket.OPEN) {
      player.ws.send(msg);
      sent++;
    }
  }
  return sent;
}

function pushAllChannels() {
  const channelData = ensureChannelsData();
  for (const ch of channelData.channels || []) {
    const payload = buildPlayerUpdatePayload(ch.id);
    pushToChannel(ch.id, payload);
    pushToDisplaysByChannelId(ch.id, payload);
  }
}

const channelBroadcastState = new Map(); // channelId -> `${scheduleId}:${ruleId}`

function getChannelResolvedStateKey(channelId) {
  const resolved = resolveScheduleForChannelId(channelId);
  if (!resolved || !resolved.schedule) return 'none';
  return `${resolved.schedule.id}:${resolved.rule ? resolved.rule.id : 'default'}`;
}

function refreshChannelByRules(channelId) {
  const key = getChannelResolvedStateKey(channelId);
  const prevKey = channelBroadcastState.get(channelId);
  if (prevKey === key) return 0;
  channelBroadcastState.set(channelId, key);
  const payload = buildPlayerUpdatePayload(channelId);
  const sent = pushToChannel(channelId, payload) + pushToDisplaysByChannelId(channelId, payload);
  if (prevKey !== undefined) {
    slog('channel_rule_switch', { channelId, from: prevKey, to: key, sent }, 'schedule');
  }
  return sent;
}

function refreshAllChannelsByRules() {
  const channelData = ensureChannelsData();
  for (const ch of channelData.channels || []) {
    refreshChannelByRules(ch.id);
  }
}

// ═══════════════════════════════════════════════
//  MagicInfo ZIP 생성 (05 계승)
// ═══════════════════════════════════════════════
function normalizeSplitMode(value) {
  const n = parseInt(value, 10);
  return n === 2 || n === 4 ? n : 1;
}

function generateCctvHtml(cameras, serverBaseUrl, splitMode) {
  const base = String(serverBaseUrl || '').replace(/\/+$/, '');
  const joinUrl = p => (base ? `${base}${p}` : p);
  const cells = cameras.map(c => {
    const e = encodeURIComponent(c.name);
    return { name: c.name, src: joinUrl(`/stream/${e}`) };
  });
  const idArr = JSON.stringify(cameras.map(c => c.name));

  const reconnectScript = `
(function(){
  var SERVER='${base}';
  var API_STREAMS=(SERVER?SERVER:'')+'/api/streams';
  var STREAM_PREFIX=(SERVER?SERVER:'')+'/stream/';
  var IDS=${idArr};
  var MAX=5; var retry={};
  function poll(){
    fetch(API_STREAMS).then(function(r){return r.json();}).then(function(d){
      var active=d.active||[];
      IDS.forEach(function(id){
        var img=document.getElementById(id);
        if(!img)return;
        if(active.indexOf(id)===-1){
          retry[id]=(retry[id]||0)+1;
          if(retry[id]>MAX)return;
          setTimeout(function(){ img.src=STREAM_PREFIX+encodeURIComponent(id)+'?_t='+Date.now(); },2000);
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
app.use(CCTV_GUARDED_PATHS, cctvFeatureGuard);
// ─── 공개 엔드포인트 (인증 불필요) ───────────────

// MJPEG 스트림 (플레이어/MagicInfo용)
app.get('/stream/:camName([^/]+)', requireCctvIpAllowed, (req, res) => {
  const data = loadCameras();
  const cam  = data.cameras.find(c => c.name === req.params.camName);
  if (!cam) { res.writeHead(404); res.end('카메라 없음'); return; }

  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
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
app.get('/api/streams', requireCctvIpAllowed, (req, res) => {
  res.json({ active: Array.from(cameraProcesses.keys()) });
});

app.get('/api/streams/status', requireCctvIpAllowed, (req, res) => {
  const now = Date.now();
  const cameras = loadCameras().cameras || [];
  const items = cameras.map(cam => {
    const entry = cameraProcesses.get(cam.name);
    if (!entry) {
      return {
        name: cam.name,
        running: false,
        status: 'stopped',
        clients: 0,
        frameCount: 0,
        firstFrameMs: null,
        lastFrameAgoMs: null,
        uptimeMs: null,
        stderrTail: []
      };
    }
    const lastFrameAgoMs = entry.lastFrameAt ? (now - entry.lastFrameAt) : null;
    let status = 'starting';
    if (entry.firstFrameMs === null) {
      status = (now - entry.startMs > HUNG_START_MS) ? 'hung' : 'starting';
    } else if (lastFrameAgoMs !== null && lastFrameAgoMs > HUNG_NO_FRAME_MS) {
      status = 'hung';
    } else {
      status = 'healthy';
    }
    return {
      name: cam.name,
      running: true,
      status,
      clients: entry.clients.size,
      frameCount: entry.frameCount,
      firstFrameMs: entry.firstFrameMs,
      lastFrameAgoMs,
      uptimeMs: now - entry.startMs,
      stderrTail: entry.stderrLines.slice(-3)
    };
  });
  res.json({ items });
});

// MagicInfo 없이도 CMS에서 직접 CCTV 레이아웃 사용
app.get('/cctv/live', requireCctvIpAllowed, (req, res) => {
  const splitMode = normalizeSplitMode(req.query.splitMode);
  const requestedNames = Array.isArray(req.query.name)
    ? req.query.name
    : req.query.name
      ? [req.query.name]
      : [];

  const orderedNames = requestedNames
    .map(name => String(name || '').trim())
    .filter(Boolean);

  if (orderedNames.length !== splitMode) {
    return res.status(400).send(`카메라 ${splitMode}개를 선택해야 합니다.`);
  }

  const cameraMap = new Map((loadCameras().cameras || []).map(cam => [cam.name, cam]));
  const selected = orderedNames.map(name => cameraMap.get(name)).filter(Boolean);

  if (selected.length !== splitMode) {
    return res.status(404).send('선택한 카메라를 찾을 수 없습니다.');
  }

  // 자체 CMS 라이브 뷰는 상대 경로를 사용해 프록시/도메인 환경에서도 안정적으로 재생
  const baseUrl = '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(generateCctvHtml(selected, baseUrl, splitMode));
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
  const resolved = resolveScheduleForChannelId(channelId);
  if (!resolved) return res.status(404).json({ error: '채널 또는 스케줄 없음' });
  res.json({
    channel: { id: resolved.channel.id, name: resolved.channel.name, scheduleId: resolved.schedule.id },
    source: resolved.source,
    rule: resolved.rule || null,
    schedule: {
      ...resolved.schedule,
      items: resolvePlayableScheduleItems(resolved.schedule.items || [])
    }
  });
});

// 중앙 집중형 CMS 클라이언트 (플레이어 실제 UI)
app.use('/client', express.static(path.join(__dirname, 'public', 'client')));

// 내부 웹 콘텐츠 페이지는 플레이어 iframe에서 인증 없이 접근 가능해야 함
app.get('/weather-content.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'weather-content.html'));
});
app.get('/designer-content.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'designer-content.html'));
});
app.get('/api/designer-contents/:id/render', (req, res) => {
  const id = String(req.params.id || '').trim();
  const item = (loadWebContents().items || []).find(entry => entry.id === id && entry.kind === 'designer');
  if (!item || !item.designer) return res.status(404).json({ error: '디자인 콘텐츠 없음' });
  res.json({
    id: item.id,
    name: item.name || '디자인 콘텐츠',
    url: item.url || buildDesignerContentUrl(item.id),
    designer: item.designer
  });
});
app.get('/api/designer-media/:filename/render', (req, res) => {
  const filename = path.basename(String(req.params.filename || '').trim());
  if (!filename) return res.status(404).json({ error: '파일 없음' });
  const filePath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '파일 없음' });
  const meta = loadMediaMeta();
  const designer = meta.items?.[filename]?.designer;
  if (!designer) return res.status(404).json({ error: '디자인 정보 없음' });
  res.json({
    filename,
    label: meta.items?.[filename]?.label || filename.replace(/^\d+_/, ''),
    designer
  });
});

// SSSP 앱 설치용 — /deploy/ sssp_config.xml 명시적 서빙 (인증 불필요)
app.get('/deploy/sssp_config.xml', (req, res) => {
  const baseUrl = getRequestBaseUrl(req);
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<SSSPConfig>
    <Widget>
        <AppID>y2013ki000.CMSPlayer</AppID>
        <AppVersion>1.1.0</AppVersion>
        <AppURL>${baseUrl}/download/app.wgt</AppURL>
    </Widget>
</SSSPConfig>`);
});
app.get('/deploy/ssp_config.xml', (req, res) => {
  const baseUrl = getRequestBaseUrl(req);
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<SSSPConfig>
    <Widget>
        <AppID>y2013ki000.CMSPlayer</AppID>
        <AppVersion>1.1.0</AppVersion>
        <AppURL>${baseUrl}/download/app.wgt</AppURL>
    </Widget>
</SSSPConfig>`);
});
app.use('/deploy', express.static(path.join(__dirname, 'player')));

// sssp_config.xml 루트 접근 (인증 불필요)
app.get('/sssp_config.xml', (req, res) => {
  const baseUrl = getRequestBaseUrl(req);
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<SSSPConfig>
    <Widget>
        <AppID>y2013ki000.CMSPlayer</AppID>
        <AppVersion>1.1.0</AppVersion>
        <AppURL>${baseUrl}/download/app.wgt</AppURL>
    </Widget>
</SSSPConfig>`);
});
app.get('/ssp_config.xml', (req, res) => {
  const baseUrl = getRequestBaseUrl(req);
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<SSSPConfig>
    <Widget>
        <AppID>y2013ki000.CMSPlayer</AppID>
        <AppVersion>1.1.0</AppVersion>
        <AppURL>${baseUrl}/download/app.wgt</AppURL>
    </Widget>
</SSSPConfig>`);
});

function resolveDownloadableWgtPath() {
  const canonicalPath = path.join(__dirname, 'public', 'app.wgt');
  if (fs.existsSync(canonicalPath)) return canonicalPath;
  return null;
}

// .wgt 실제 파일 다운로드 경로 (sssp_config.xml의 AppURL)
app.get('/download/app.wgt', (req, res) => {
  const wgtPath = resolveDownloadableWgtPath();
  if (!wgtPath) return res.status(404).send('WGT 파일 없음');
  res.setHeader('Content-Type', 'application/widget');
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(wgtPath);
});

// /deploy/app.wgt 에 대한 상대 경로 서빙 추가
app.get('/deploy/app.wgt', (req, res) => {
  const wgtPath = resolveDownloadableWgtPath();
  if (!wgtPath) return res.status(404).send('WGT 파일 없음');
  res.setHeader('Content-Type', 'application/widget');
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(wgtPath);
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
    const c = parseCookies(req);
    if (c.session) sessions.delete(c.session); // 기존 세션 교체
    const { token, meta } = createSessionToken();
    sessions.set(token, meta);
    slogReq(req, 'login_success', { id: String(id || '').trim() || null }, 'system');
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Strict`);
    return res.redirect('/');
  }
  slogReq(req, 'login_failed', { id: String(id || '').trim() || null }, 'system');
  res.send(loginHtml(true));
});
app.get('/logout', (req, res) => {
  const c = parseCookies(req);
  if (c.session) sessions.delete(c.session);
  slogReq(req, 'logout', {}, 'system');
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
  res.redirect('/login');
});

// 세션 만료 정리
setInterval(pruneExpiredSessions, 60 * 1000);

// 관리자 UI
app.use(express.static(path.join(__dirname, 'public')));

// ─── 미디어 라이브러리 API ─────────────────────────

app.get('/api/media', (req, res) => {
  const meta = loadMediaMeta();
  const files = fs.readdirSync(MEDIA_DIR)
    .filter(f => !f.startsWith('.'))
    .map(name => {
      const stat = fs.statSync(path.join(MEDIA_DIR, name));
      const ext  = path.extname(name).toLowerCase();
      const type = VIDEO_EXTS.has(ext) ? 'video' : 'image';
      return {
        filename: name,
        type,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        label: meta.items?.[name]?.label || '',
        designer: meta.items?.[name]?.designer || null,
        hidden: !!meta.items?.[name]?.hidden
      };
    })
    .filter(item => !item.hidden)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const webItems = (loadWebContents().items || []).map(item => ({
    filename: webContentKey(item.id),
    type: 'web',
    size: 0,
    createdAt: item.createdAt || new Date().toISOString(),
    webUrl: item.url,
    label: item.name || '웹 콘텐츠',
    webKind: item.kind || 'web',
    designer: item.kind === 'designer' ? (item.designer || null) : null
  }));
  res.json([...files, ...webItems].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
});

app.post('/api/media', upload.array('files', 20), (req, res) => {
  const groupId  = req.body.groupId || null;
  const hidden = String(req.body.hidden || '').trim() === '1';
  const uploaded = (req.files || []).map(f => ({
    filename: f.filename, type: VIDEO_EXTS.has(path.extname(f.filename).toLowerCase()) ? 'video' : 'image',
    size: f.size
  }));
  if (hidden && uploaded.length) {
    const meta = loadMediaMeta();
    meta.items = meta.items || {};
    uploaded.forEach((f) => {
      meta.items[f.filename] = { ...(meta.items[f.filename] || {}), hidden: true };
    });
    saveMediaMeta(meta);
  }
  if (groupId) {
    const grpData = loadMediaGroups();
    const grp = grpData.groups.find(g => g.id === groupId);
    if (grp) {
      uploaded.forEach(f => { if (!grp.files.includes(f.filename)) grp.files.push(f.filename); });
      saveMediaGroups(grpData);
    }
  }
  slogReq(req, 'media_upload', { files: uploaded.map(f => f.filename), count: uploaded.length, groupId, hidden }, 'system');
  res.json({ ok: true, files: uploaded });
});

app.delete('/api/media/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename);
  if (filename.startsWith('web:')) {
    const webId = filename.slice(4);
    const webData = loadWebContents();
    const idx = (webData.items || []).findIndex(x => x.id === webId);
    if (idx === -1) return res.status(404).json({ error: '웹 콘텐츠 없음' });
    const [removed] = webData.items.splice(idx, 1);
    const removedSourceFiles = removed?.kind === 'designer'
      ? [...collectDesignerSourceFilenamesFromPayload(removed.designer)]
      : [];
    saveWebContents(webData);
    const grpData = loadMediaGroups();
    grpData.groups.forEach(g => { g.files = (g.files || []).filter(f => f !== filename); });
    saveMediaGroups(grpData);
    reconcileDesignerSourceMediaHiddenState();
    if (removedSourceFiles.length) {
      const stillUsed = collectDesignerSourceFilenames();
      const meta = loadMediaMeta();
      let metaChanged = false;
      let groupChanged = false;
      for (const sourceFile of removedSourceFiles) {
        if (stillUsed.has(sourceFile)) continue;
        const sourcePath = path.join(MEDIA_DIR, sourceFile);
        try {
          if (fs.existsSync(sourcePath)) await fs.promises.unlink(sourcePath);
        } catch {}
        if (meta.items?.[sourceFile]) {
          delete meta.items[sourceFile];
          metaChanged = true;
        }
        grpData.groups.forEach(g => {
          const before = (g.files || []).length;
          g.files = (g.files || []).filter(f => f !== sourceFile);
          if (g.files.length !== before) groupChanged = true;
        });
      }
      if (metaChanged) saveMediaMeta(meta);
      if (groupChanged) saveMediaGroups(grpData);
    }
    slogReq(req, 'web_content_delete', { id: removed.id, name: removed.name, url: removed.url }, 'system');
    return res.json({ ok: true });
  }
  const filepath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '파일 없음' });
  try {
    await fs.promises.unlink(filepath);
  } catch (err) {
    if (err?.code === 'ENOENT') return res.status(404).json({ error: '파일 없음' });
    if (err?.code === 'EPERM' || err?.code === 'EBUSY') {
      return res.status(409).json({ error: '파일이 사용 중이어서 삭제할 수 없습니다' });
    }
    slogReq(req, 'media_delete_error', { filename, error: err?.message || String(err) }, 'system');
    return res.status(500).json({ error: '파일 삭제 실패' });
  }
  // 그룹에서도 제거
  const grpData = loadMediaGroups();
  grpData.groups.forEach(g => { g.files = g.files.filter(f => f !== filename); });
  saveMediaGroups(grpData);
  const meta = loadMediaMeta();
  if (meta.items?.[filename]) {
    delete meta.items[filename];
    saveMediaMeta(meta);
  }
  reconcileDesignerSourceMediaHiddenState();
  slogReq(req, 'media_delete', { filename }, 'system');
  res.json({ ok: true });
});

app.put('/api/media/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (filename.startsWith('web:')) return res.status(400).json({ error: '웹 콘텐츠는 별도 수정 API 사용' });
  const label = String(req.body?.label || '').trim();
  const hidden = req.body?.hidden;
  const designer = req.body?.designer !== undefined ? normalizeDesignerPayload(req.body?.designer) : undefined;
  if (req.body?.designer !== undefined && !designer) {
    return res.status(400).json({ error: '디자인 콘텐츠 정보가 올바르지 않습니다' });
  }
  const filePath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '파일 없음' });
  const meta = loadMediaMeta();
  meta.items = meta.items || {};
  const next = { ...(meta.items[filename] || {}) };
  if (label) next.label = label;
  else delete next.label;
  if (hidden !== undefined) next.hidden = String(hidden) === '1' || hidden === true;
  if (designer !== undefined) next.designer = designer;
  if (!Object.keys(next).length) delete meta.items[filename];
  else meta.items[filename] = next;
  saveMediaMeta(meta);
  reconcileDesignerSourceMediaHiddenState();
  slogReq(req, 'media_update', { filename, label: label || null, hidden: hidden !== undefined ? next.hidden : undefined, designer: designer !== undefined }, 'system');
  res.json({ ok: true, filename, label, hidden: next.hidden || false, designer: next.designer || null });
});

// ─── 미디어 그룹 API ──────────────────────────────

app.get('/api/media-groups', (req, res) => {
  const data = loadMediaGroups();
  const webMap = new Map((loadWebContents().items || []).map(item => [webContentKey(item.id), item]));
  const enriched = {
    groups: data.groups.map(g => ({
      ...g,
      files: g.files
        .filter(fn => fn.startsWith('web:') ? webMap.has(fn) : fs.existsSync(path.join(MEDIA_DIR, fn)))
        .map(fn => {
          if (fn.startsWith('web:')) {
            const web = webMap.get(fn);
            return {
              filename: fn,
              type: 'web',
              webUrl: web?.url || '',
              label: web?.name || '웹 콘텐츠',
              webKind: web?.kind || 'web',
              designer: web?.kind === 'designer' ? (web?.designer || null) : null
            };
          }
          const ext = path.extname(fn).toLowerCase();
          return { filename: fn, type: VIDEO_EXTS.has(ext) ? 'video' : 'image' };
        })
    }))
  };
  res.json(enriched);
});

// ─── 웹 콘텐츠 API ──────────────────────────────
app.get('/api/web-contents', (req, res) => {
  res.json(loadWebContents());
});

app.post('/api/web-contents', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const url = String(req.body?.url || '').trim();
  const groupId = String(req.body?.groupId || '').trim();
  if (!isAllowedWebUrl(url)) {
    return res.status(400).json({ error: '유효한 웹 URL 또는 내부 경로 필요' });
  }
  const data = loadWebContents();
  const item = {
    id: `web_${crypto.randomBytes(4).toString('hex')}`,
    name: name || `WEB ${data.items.length + 1}`,
    url,
    createdAt: new Date().toISOString()
  };
  data.items.push(item);
  saveWebContents(data);
  if (groupId) {
    const grpData = loadMediaGroups();
    const grp = (grpData.groups || []).find(g => g.id === groupId);
    if (grp && !(grp.files || []).includes(webContentKey(item.id))) {
      grp.files.push(webContentKey(item.id));
      saveMediaGroups(grpData);
    }
  }
  slogReq(req, 'web_content_create', { id: item.id, name: item.name, url: item.url, groupId: groupId || null }, 'system');
  res.json(item);
});

app.put('/api/web-contents/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  const name = String(req.body?.name || '').trim();
  const url = String(req.body?.url || '').trim();
  if (!name) return res.status(400).json({ error: '콘텐츠 이름 필요' });
  if (!isAllowedWebUrl(url)) {
    return res.status(400).json({ error: '유효한 웹 URL 또는 내부 경로 필요' });
  }
  const data = loadWebContents();
  const item = (data.items || []).find(entry => entry.id === id);
  if (!item) return res.status(404).json({ error: '웹 콘텐츠 없음' });
  if (item.kind === 'designer') return res.status(400).json({ error: '디자인 콘텐츠는 전용 수정 API를 사용하세요' });
  item.name = name;
  item.url = url;
  item.updatedAt = new Date().toISOString();
  saveWebContents(data);
  syncScheduleItemsForWebContent(item.id, { label: item.name, webUrl: item.url });
  reconcileDesignerSourceMediaHiddenState();
  slogReq(req, 'web_content_update', { id: item.id, name: item.name, url: item.url }, 'system');
  res.json(item);
});

app.post('/api/designer-contents', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const groupId = String(req.body?.groupId || '').trim();
  const designer = normalizeDesignerPayload(req.body?.designer);
  if (!designer) return res.status(400).json({ error: '디자인 콘텐츠 정보가 올바르지 않습니다' });
  const data = loadWebContents();
  const id = `web_${crypto.randomBytes(4).toString('hex')}`;
  const item = {
    id,
    kind: 'designer',
    name: name || `디자인 콘텐츠 ${data.items.length + 1}`,
    url: buildDesignerContentUrl(id),
    designer,
    createdAt: new Date().toISOString()
  };
  data.items.push(item);
  saveWebContents(data);
  if (groupId) {
    const grpData = loadMediaGroups();
    const grp = (grpData.groups || []).find(g => g.id === groupId);
    if (grp && !(grp.files || []).includes(webContentKey(item.id))) {
      grp.files.push(webContentKey(item.id));
      saveMediaGroups(grpData);
    }
  }
  reconcileDesignerSourceMediaHiddenState();
  slogReq(req, 'designer_content_create', { id: item.id, name: item.name, groupId: groupId || null }, 'system');
  res.json(item);
});

app.put('/api/designer-contents/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  const name = String(req.body?.name || '').trim();
  const designer = normalizeDesignerPayload(req.body?.designer);
  if (!name) return res.status(400).json({ error: '콘텐츠 이름 필요' });
  if (!designer) return res.status(400).json({ error: '디자인 콘텐츠 정보가 올바르지 않습니다' });
  const data = loadWebContents();
  const item = (data.items || []).find(entry => entry.id === id && entry.kind === 'designer');
  if (!item) return res.status(404).json({ error: '디자인 콘텐츠 없음' });
  item.name = name;
  item.designer = designer;
  item.url = buildDesignerContentUrl(item.id);
  item.updatedAt = new Date().toISOString();
  saveWebContents(data);
  syncScheduleItemsForWebContent(item.id, { label: item.name, webUrl: item.url });
  reconcileDesignerSourceMediaHiddenState();
  slogReq(req, 'designer_content_update', { id: item.id, name: item.name }, 'system');
  res.json(item);
});

app.post('/api/media-groups', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '그룹명 필요' });
  const data = loadMediaGroups();
  const g = { id: `grp_${crypto.randomBytes(4).toString('hex')}`, name: name.trim(), files: [] };
  data.groups.push(g);
  saveMediaGroups(data);
  slogReq(req, 'media_group_create', { id: g.id, name: g.name }, 'system');
  res.json(g);
});

app.put('/api/media-groups/:id', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '그룹명 필요' });
  const data = loadMediaGroups();
  const group = data.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: '그룹 없음' });
  group.name = name;
  saveMediaGroups(data);
  slogReq(req, 'media_group_update', { id: group.id, name: group.name }, 'system');
  res.json(group);
});

app.delete('/api/media-groups/:id', (req, res) => {
  const data = loadMediaGroups();
  const idx = data.groups.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '그룹 없음' });
  const [removed] = data.groups.splice(idx, 1);
  saveMediaGroups(data);
  slogReq(req, 'media_group_delete', { id: removed.id }, 'system');
  res.json({ ok: true });
});

// 파일을 특정 그룹으로 이동 (groupId: null → 미분류)
app.patch('/api/media/:filename/group', (req, res) => {
  const filename = path.basename(req.params.filename);
  const { groupId } = req.body;
  const data = loadMediaGroups();
  data.groups.forEach(g => { g.files = g.files.filter(f => f !== filename); });
  if (groupId) {
    const g = data.groups.find(g => g.id === groupId);
    if (g && !g.files.includes(filename)) g.files.push(filename);
  }
  saveMediaGroups(data);
  res.json({ ok: true });
});

// ─── CCTV 콘텐츠 API (콘텐츠 탭에서 생성/관리) ──────────────────────────────

app.get('/api/cctv-contents', (req, res) => {
  const data = loadCctvContents();
  res.json(data);
});

app.post('/api/cctv-contents', (req, res) => {
  const { name, splitMode, cameraNames, duration } = req.body || {};
  const mode = normalizeSplitMode(splitMode);
  const camNames = Array.isArray(cameraNames)
    ? cameraNames.map(v => String(v || '').trim()).filter(Boolean)
    : [];
  const title = String(name || '').trim();
  if (!title) return res.status(400).json({ error: '콘텐츠 이름 필요' });
  if (camNames.length !== mode) return res.status(400).json({ error: `카메라 ${mode}개를 선택해야 합니다` });

  const cameraMap = new Map((loadCameras().cameras || []).map(cam => [cam.name, cam]));
  if (!camNames.every(n => cameraMap.has(n))) return res.status(404).json({ error: '선택한 카메라를 찾을 수 없습니다' });

  const params = new URLSearchParams();
  params.set('splitMode', String(mode));
  camNames.forEach(n => params.append('name', n));
  const cctvUrl = `/cctv/live?${params.toString()}`;

  const data = loadCctvContents();
  const item = {
    id: `cctv_${crypto.randomBytes(4).toString('hex')}`,
    name: title,
    splitMode: mode,
    cameraNames: camNames,
    cctvUrl,
    duration: Math.max(5, parseInt(duration, 10) || 30),
    createdAt: new Date().toISOString()
  };
  data.items.push(item);
  saveCctvContents(data);
  slogReq(req, 'cctv_content_create', { id: item.id, name: item.name, splitMode: item.splitMode }, 'schedule');
  res.json(item);
});

app.delete('/api/cctv-contents/:id', (req, res) => {
  const data = loadCctvContents();
  const idx = data.items.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'CCTV 콘텐츠 없음' });
  const [removed] = data.items.splice(idx, 1);
  saveCctvContents(data);
  slogReq(req, 'cctv_content_delete', { id: removed.id, name: removed.name }, 'schedule');
  res.json({ ok: true });
});

// ─── 스케줄 API ───────────────────────────────────

app.get('/api/schedules', (req, res) => {
  res.json(ensureSchedulesData());
});

app.get('/api/schedule-groups', (req, res) => {
  const data = ensureSchedulesData();
  res.json({ groups: data.groups || [] });
});

app.post('/api/schedule-groups', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '그룹명 필요' });
  const data = ensureSchedulesData();
  const group = {
    id: `sg_${crypto.randomBytes(4).toString('hex')}`,
    name,
    createdAt: new Date().toISOString()
  };
  data.groups.push(group);
  saveSchedules(data);
  slogReq(req, 'schedule_group_create', { id: group.id, name: group.name }, 'schedule');
  res.json(group);
});

app.put('/api/schedule-groups/:id', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '그룹명 필요' });
  const data = ensureSchedulesData();
  const group = (data.groups || []).find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: '그룹 없음' });
  group.name = name;
  saveSchedules(data);
  slogReq(req, 'schedule_group_update', { id: group.id, name: group.name }, 'schedule');
  res.json(group);
});

app.delete('/api/schedule-groups/:id', (req, res) => {
  const data = ensureSchedulesData();
  const idx = (data.groups || []).findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '그룹 없음' });
  const [removed] = data.groups.splice(idx, 1);
  for (const sch of data.channels || []) {
    if (sch.groupId === removed.id) sch.groupId = null;
  }
  saveSchedules(data);
  slogReq(req, 'schedule_group_delete', { id: removed.id, name: removed.name }, 'schedule');
  res.json({ ok: true });
});

// 채널 생성
app.post('/api/schedules', (req, res) => {
  const { name, groupId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '스케줄명 필요' });
  const data = ensureSchedulesData();
  if (groupId && !data.groups.some(g => g.id === groupId)) {
    return res.status(400).json({ error: '존재하지 않는 스케줄 그룹' });
  }
  const ch = { id: `ch_${crypto.randomBytes(4).toString('hex')}`, name: name.trim(), items: [], groupId: groupId || null };
  data.channels.push(ch);
  saveSchedules(data);
  slogReq(req, 'schedule_channel_create', { id: ch.id, name: ch.name }, 'schedule');
  res.json(ch);
});

// 채널 수정 (이름 + 아이템 목록 전체 교체)
app.put('/api/schedules/:id', (req, res) => {
  const data = ensureSchedulesData();
  const ch = data.channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: '채널 없음' });
  if (req.body.name  !== undefined) ch.name  = req.body.name.trim();
  if (req.body.items !== undefined) ch.items = req.body.items;
  if (req.body.groupId !== undefined) {
    const groupId = req.body.groupId || null;
    if (groupId && !data.groups.some(g => g.id === groupId)) {
      return res.status(400).json({ error: '존재하지 않는 스케줄 그룹' });
    }
    ch.groupId = groupId;
  }
  saveSchedules(data);
  slogReq(req, 'schedule_channel_update', { id: ch.id }, 'schedule');
  
  const channelData = ensureChannelsData();
  const targetChannelIds = (channelData.channels || [])
    .filter(c => c.scheduleId === ch.id || (c.rules || []).some(rule => rule.scheduleId === ch.id))
    .map(c => c.id);

  let wsSent = 0;
  targetChannelIds.forEach(channelId => {
    const payload = buildPlayerUpdatePayload(channelId);
    channelBroadcastState.set(channelId, getChannelResolvedStateKey(channelId));
    wsSent += pushToChannel(channelId, payload);
    wsSent += pushToDisplaysByChannelId(channelId, payload);
  });
  res.json({ ok: true, pushed: wsSent, targetChannels: targetChannelIds.length });
});

// 채널 삭제
app.delete('/api/schedules/:id', (req, res) => {
  const data = ensureSchedulesData();
  const idx  = data.channels.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '채널 없음' });
  const [removed] = data.channels.splice(idx, 1);
  saveSchedules(data);
  const channelData = ensureChannelsData();
  const affectedChannelIds = [];
  (channelData.channels || []).forEach(ch => {
    const beforeRuleCount = (ch.rules || []).length;
    if (ch.scheduleId === removed.id) {
      ch.scheduleId = null;
      affectedChannelIds.push(ch.id);
    }
    ch.rules = (ch.rules || []).filter(rule => rule.scheduleId !== removed.id);
    if ((ch.rules || []).length !== beforeRuleCount && !affectedChannelIds.includes(ch.id)) {
      affectedChannelIds.push(ch.id);
    }
  });
  saveChannels(channelData);
  affectedChannelIds.forEach(channelId => {
    channelBroadcastState.set(channelId, getChannelResolvedStateKey(channelId));
    const payload = buildPlayerUpdatePayload(channelId);
    pushToChannel(channelId, payload);
    pushToDisplaysByChannelId(channelId, payload);
  });
  slogReq(req, 'schedule_channel_delete', { id: removed.id }, 'schedule');
  res.json({ ok: true });
});

// 즉시 푸시 (저장 없이 강제 전송)
app.post('/api/schedules/:id/push', (req, res) => {
  const scheduleId = req.params.id;
  const schedules = ensureSchedulesData();
  const schedule = schedules.channels.find(c => c.id === scheduleId);
  if (!schedule) return res.status(404).json({ error: '채널 없음' });
  const channelData = ensureChannelsData();
  const targetChannelIds = (channelData.channels || [])
    .filter(c => c.scheduleId === scheduleId || (c.rules || []).some(rule => rule.scheduleId === scheduleId))
    .map(c => c.id);
  let sent = 0;
  targetChannelIds.forEach(channelId => {
    const payload = buildPlayerUpdatePayload(channelId);
    channelBroadcastState.set(channelId, getChannelResolvedStateKey(channelId));
    sent += pushToChannel(channelId, payload);
    sent += pushToDisplaysByChannelId(channelId, payload);
  });
  slogReq(req, 'schedule_push', { id: scheduleId, sent, targetChannels: targetChannelIds.length }, 'schedule');
  res.json({ ok: true, sent, targetChannels: targetChannelIds.length });
});

// ─── 채널 API ───────────────────────────────────

app.get('/api/channels', (req, res) => {
  const channelData = ensureChannelsData();
  const schedules = loadSchedules();
  const channels = (channelData.channels || []).map(ch => {
    const schedule = schedules.channels.find(s => s.id === ch.scheduleId);
    const resolved = resolveScheduleForChannelId(ch.id);
    return {
      ...ch,
      scheduleName: schedule ? schedule.name : null,
      hasSchedule: !!schedule,
      activeScheduleId: resolved?.schedule?.id || null,
      activeScheduleName: resolved?.schedule?.name || null,
      activeRuleId: resolved?.rule?.id || null,
      activeSource: resolved?.source || null
    };
  });
  res.json({ channels });
});

app.post('/api/channels', (req, res) => {
  const { name, scheduleId, rules, defaultColor } = req.body || {};
  const channelName = String(name || '').trim();
  if (!channelName) return res.status(400).json({ error: '채널명 필요' });
  const schedules = loadSchedules();
  if (scheduleId && !schedules.channels.some(s => s.id === scheduleId)) {
    return res.status(400).json({ error: '존재하지 않는 스케줄' });
  }
  let normalizedRules;
  try {
    normalizedRules = normalizeRulesInput(rules, schedules);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const channelData = ensureChannelsData();
  const ch = {
    id: `vc_${crypto.randomBytes(4).toString('hex')}`,
    name: channelName,
    scheduleId: scheduleId || null,
    defaultColor: /^#[0-9a-fA-F]{6}$/.test(String(defaultColor || '')) ? String(defaultColor) : '#5e81ac',
    rules: normalizedRules || [],
    createdAt: new Date().toISOString()
  };
  channelData.channels.push(ch);
  saveChannels(channelData);
  slogReq(req, 'channel_create', { id: ch.id, name: ch.name, scheduleId: ch.scheduleId }, 'schedule');
  refreshChannelByRules(ch.id);
  res.json(ch);
});

app.put('/api/channels/:id', (req, res) => {
  const channelData = ensureChannelsData();
  const ch = channelData.channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: '채널 없음' });
  const schedules = loadSchedules();
  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: '채널명 필요' });
    ch.name = name;
  }
  if (req.body.scheduleId !== undefined) {
    const scheduleId = req.body.scheduleId || null;
    if (scheduleId && !schedules.channels.some(s => s.id === scheduleId)) {
      return res.status(400).json({ error: '존재하지 않는 스케줄' });
    }
    ch.scheduleId = scheduleId;
  }
  if (req.body.defaultColor !== undefined) {
    const c = String(req.body.defaultColor || '').trim();
    ch.defaultColor = /^#[0-9a-fA-F]{6}$/.test(c) ? c : (ch.defaultColor || '#5e81ac');
  }
  if (req.body.rules !== undefined) {
    try {
      ch.rules = normalizeRulesInput(req.body.rules, schedules);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  saveChannels(channelData);
  slogReq(req, 'channel_update', { id: ch.id, name: ch.name, scheduleId: ch.scheduleId }, 'schedule');
  refreshChannelByRules(ch.id);
  const payload = buildPlayerUpdatePayload(ch.id);
  pushToChannel(ch.id, payload);
  pushToDisplaysByChannelId(ch.id, payload);
  res.json(ch);
});

app.post('/api/channels/rebroadcast', (req, res) => {
  pushAllChannels();
  slogReq(req, 'channel_rebroadcast_all', { by: 'manager' }, 'schedule');
  res.json({ ok: true });
});

app.delete('/api/channels/:id', (req, res) => {
  const channelData = ensureChannelsData();
  const idx = channelData.channels.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '채널 없음' });
  const [removed] = channelData.channels.splice(idx, 1);
  saveChannels(channelData);
  channelBroadcastState.delete(removed.id);
  const displayData = loadDisplays();
  displayData.displays.forEach(d => {
    if (d.channelId === removed.id) d.channelId = null;
  });
  saveDisplays(displayData);
  slogReq(req, 'channel_delete', { id: removed.id, name: removed.name }, 'schedule');
  res.json({ ok: true });
});

// ─── 디스플레이 API ───────────────────────────────

app.get('/api/displays', (req, res) => {
  res.json(ensureDisplaysData());
});

app.post('/api/displays', (req, res) => {
  const { name, ip, location, channelId, mac, duid, playbackProfile } = req.body;
  if (!name || !ip) return res.status(400).json({ error: '이름·IP 필요' });
  const channelData = ensureChannelsData();
  if (channelId && !(channelData.channels || []).some(c => c.id === channelId)) {
    return res.status(400).json({ error: '존재하지 않는 채널' });
  }
  const data = ensureDisplaysData();
  const d = {
    id: `d_${crypto.randomBytes(4).toString('hex')}`,
    name: name.trim(), ip: ip.trim(),
    location: (location || '').trim(),
    mac: (mac || '').trim(),
    duid: (duid || '').trim(),
    channelId: channelId || null,
    playbackProfile: normalizePlaybackProfile(playbackProfile),
    addedAt: new Date().toISOString()
  };
  data.displays.push(d);
  saveDisplays(data);
  slogReq(req, 'display_add', { id: d.id, name: d.name, ip: d.ip }, 'control');
  res.json(d);
});

app.put('/api/displays/:id', (req, res) => {
  const data = ensureDisplaysData();
  const d = data.displays.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: '디스플레이 없음' });
  const prevChannelId = d.channelId || null;
  const channelData = ensureChannelsData();
  if (req.body.channelId && !(channelData.channels || []).some(c => c.id === req.body.channelId)) {
    return res.status(400).json({ error: '존재하지 않는 채널' });
  }
  ['name', 'ip', 'location', 'channelId', 'mac', 'duid'].forEach(k => {
    if (req.body[k] !== undefined) d[k] = typeof req.body[k] === 'string' ? req.body[k].trim() : req.body[k];
  });
  if (req.body.playbackProfile !== undefined) {
    d.playbackProfile = normalizePlaybackProfile(req.body.playbackProfile);
  }
  saveDisplays(data);
  slogReq(req, 'display_update', { id: d.id }, 'control');
  if (req.body.channelId !== undefined && d.channelId !== prevChannelId) {
    const player = getActivePlayerForDisplay(d);
    if (player) {
      player.ws.send(JSON.stringify(buildPlayerUpdatePayload(d.channelId)));
    }
  }
  res.json({ ok: true });
});

app.delete('/api/displays/:id', (req, res) => {
  const data = loadDisplays();
  const idx  = data.displays.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '디스플레이 없음' });
  const [removed] = data.displays.splice(idx, 1);
  saveDisplays(data);
  slogReq(req, 'display_remove', { id: removed.id, name: removed.name }, 'control');
  res.json({ ok: true });
});

// 그룹 제어 (채널에 연결된 모든 TV)
// NOTE: /:id/control 보다 먼저 선언해야 "group"이 id로 오인되지 않습니다.
app.post('/api/displays/group/control', async (req, res) => {
  const { channelId, action, value } = req.body;
  const data = loadDisplays();
  const targets = data.displays.filter(d => d.channelId === channelId);
  const batch = await executeBatchAction(targets, action, value, req.body || {});
  res.json(batch);
});

// MDC 제어
app.post('/api/displays/:id/control', async (req, res) => {
  const { action, value } = req.body;
  const data = loadDisplays();
  const d    = data.displays.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: '디스플레이 없음' });
  const result = await executeDisplayAction(d, action, value, req.body || {});
  if (!result.ok) return res.status(500).json({ error: result.error, result });
  res.json({ ok: true, result });
});

// 순차 제어
app.post('/api/displays/:id/control-sequence', async (req, res) => {
  const data = loadDisplays();
  const d = data.displays.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: '디스플레이 없음' });
  const result = await executeActionSequence(d, req.body?.actions, req.body || {});
  if (!result.ok) return res.status(500).json({ error: result.error, result });
  res.json({ ok: true, result });
});

// Wake-on-LAN
app.post('/api/displays/:id/wol', async (req, res) => {
  const data = loadDisplays();
  const d = data.displays.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: '디스플레이 없음' });
  const result = await executeDisplayAction(d, 'wol', null, req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error, result });
  res.json({ ok: true, result });
});

// MDC 상태 캐시 전체 조회
app.get('/api/displays/mdc-status', (req, res) => {
  const result = {};
  for (const [ip, st] of mdcStatusCache) result[ip] = st;
  res.json(result);
});

// 단일 기기 온디맨드 MDC 폴링
app.post('/api/displays/:id/mdc-poll', async (req, res) => {
  const data = loadDisplays();
  const d = data.displays.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: '디스플레이 없음' });
  await pollMdcStatus(d).catch(() => {});
  res.json(mdcStatusCache.get(d.ip) || { power: 'offline', ts: Date.now() });
});

// 선택 기기 일괄 제어
app.post('/api/displays/bulk-action', async (req, res) => {
  const { ids, action, value } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '대상 기기 ID 목록이 필요합니다' });
  if (!action) return res.status(400).json({ error: 'action 필요' });
  const data = loadDisplays();
  const idSet = new Set(ids);
  const targets = data.displays.filter(d => idSet.has(d.id));
  if (!targets.length) return res.status(404).json({ error: '대상 기기를 찾을 수 없습니다' });
  const batch = await executeBatchAction(targets, action, value, req.body || {});
  res.json(batch);
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

app.get('/api/cctv-allowed-ips', (req, res) => {
  const data = loadCctvAllowedIps();
  data.ips = Array.isArray(data.ips) ? data.ips.map(v => String(v || '').trim()).filter(Boolean) : [];
  res.json({ ips: data.ips });
});

app.post('/api/cctv-allowed-ips', (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'IP 필요' });
  if (!/^[0-9a-zA-Z:.]+$/.test(ip)) return res.status(400).json({ error: 'IP 형식 오류' });
  const data = loadCctvAllowedIps();
  data.ips = Array.isArray(data.ips) ? data.ips : [];
  if (!data.ips.includes(ip)) data.ips.push(ip);
  saveCctvAllowedIps(data);
  slog('cctv_allowed_ip_add', { ip }, 'system');
  res.json({ ok: true, ips: data.ips });
});

app.delete('/api/cctv-allowed-ips/:ip', (req, res) => {
  const ip = String(req.params.ip || '').trim();
  const data = loadCctvAllowedIps();
  data.ips = Array.isArray(data.ips) ? data.ips : [];
  data.ips = data.ips.filter(v => v !== ip);
  saveCctvAllowedIps(data);
  slog('cctv_allowed_ip_delete', { ip }, 'system');
  res.json({ ok: true, ips: data.ips });
});

// MagicInfo ZIP 생성
app.post('/api/generate', (req, res) => {
  const { cameras: newCameras, splitMode: rawSplitMode, images } = req.body;
  const splitMode = normalizeSplitMode(rawSplitMode);
  if (!newCameras || !Array.isArray(newCameras)) return res.status(400).json({ error: '요청 오류' });
  if (newCameras.length !== splitMode) return res.status(400).json({ error: `카메라 ${splitMode}개를 선택해야 합니다` });

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

  const htmlContent = generateCctvHtml(resolvedCameras, getRequestBaseUrl(req), splitMode);
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
  const requestedLimit = parseInt(req.query.limit || req.query.lines, 10);
  const limit    = Math.min(requestedLimit || 200, 5000);
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

app.get('/api/logs/download', (req, res) => {
  const category = String(req.query.category || 'all').trim() || 'all';
  const fromMs = req.query.from ? Date.parse(String(req.query.from)) : NaN;
  const toMs = req.query.to ? Date.parse(String(req.query.to)) : NaN;
  if (!fs.existsSync(LOG_FILE)) return res.status(404).send('로그 파일 없음');
  const entries = fs.readFileSync(LOG_FILE, 'utf8')
    .trim().split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter(l => category === 'all' || l.category === category)
    .filter(l => {
      const ts = Date.parse(String(l.ts || ''));
      if (!Number.isFinite(ts)) return false;
      if (Number.isFinite(fromMs) && ts < fromMs) return false;
      if (Number.isFinite(toMs) && ts > toMs) return false;
      return true;
    });
  const filename = `cms-log-${category}-${new Date().toISOString().slice(0, 10)}.log`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(entries.map(entry => JSON.stringify(entry)).join('\n'));
});

// 서버 정보 API
app.get('/api/server-info', (req, res) => {
  const base = getRequestBaseUrl(req);
  let hostPort = '';
  try {
    hostPort = new URL(base).host;
  } catch {
    hostPort = `${PROXY_IP}:${PORT}`;
  }
  const [hostOnly, portOnly] = String(hostPort).split(':');
  res.json({
    ip: hostOnly || PROXY_IP,
    port: Number(portOnly) || PORT,
    uptime: process.uptime(),
    cameras: cameraProcesses.size,
    wsClients: [...channelClients.values()].reduce((s, c) => s + c.size, 0),
    onlinePlayers: activePlayers.size
  });
});

// 실시간 온라인 플레이어 목록 API (IP 기반)
app.get('/api/players/online', (req, res) => {
  const list = [];
  const now = Date.now();
  for (const [, info] of activePlayers) {
    const heartbeatAgeMs = info.lastHeartbeatAt ? (now - info.lastHeartbeatAt) : null;
    list.push({
      ip: info.ip,
      lastSeen: info.lastSeen,
      duid: info.duid || null,
      channelId: info.channelId || null,
      heartbeatAt: info.lastHeartbeatAt || null,
      heartbeatAgeMs,
      heartbeatStale: heartbeatAgeMs !== null ? heartbeatAgeMs > PLAYER_HEARTBEAT_STALE_MS : true,
      player: info.player || null
    });
  }
  res.json(list);
});

// 플레이어 원격 재시작 API (IP 기반)
app.post('/api/players/reload', (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP 필요' });
  const found = getActivePlayerByIp(ip);
  if (!found) return res.status(404).json({ error: '플레이어가 온라인이 아닙니다' });
  found.ws.send(JSON.stringify({ type: 'reload' }));
  slog('player_reload_cmd', { ip }, 'control');
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════
//  WebSocket 처리 (기기 식별 및 상태 관리)
// ═══════════════════════════════════════════════
const activePlayers = new Map(); // duid -> { ws, lastSeen, ip, ... }

wss.on('connection', (ws, req) => {
  const url       = new URL(req.url, `http://localhost`);
  const channelId = url.searchParams.get('channel') || null;
  let duid        = url.searchParams.get('duid') || null;
  const ip        = req.socket.remoteAddress.replace(/^.*:/, ''); // IPv6 prefix 제거

  // DUID가 없거나 unknown이면 IP를 ID로 사용
  if (!duid || duid === 'unknown') {
    duid = `IP_${ip.replace(/\./g, '_')}`;
  }

  ws.channelId = channelId;
  ws.duid      = duid;

  if (duid) {
    activePlayers.set(duid, {
      ws,
      lastSeen: Date.now(),
      ip,
      duid,
      channelId: channelId || null,
      lastHeartbeatAt: null,
      player: null
    });
    slog('player_connect', { ip }, 'system');

    const dispData = loadDisplays();
    const displays = dispData.displays || [];
    let dInfo = null;
    if (!duid.startsWith('IP_')) {
      dInfo = displays.find(d => String(d.duid || '').trim() === duid) || displays.find(d => d.ip === ip);
      // 웹에서 수동 입력한 DUID는 보존:
      // 기존 DUID가 비어있을 때만 자동 채움
      if (dInfo && !String(dInfo.duid || '').trim()) {
        dInfo.duid = duid;
        saveDisplays(dispData);
      }
    } else {
      dInfo = displays.find(d => d.ip === ip);
    }

    // 이 기기에 할당된 채널 정보가 있다면 전송
    if (dInfo && dInfo.channelId) {
      ws.send(JSON.stringify(buildPlayerUpdatePayload(dInfo.channelId)));
    }
  }

  if (channelId) {
    if (!channelClients.has(channelId)) channelClients.set(channelId, new Set());
    channelClients.get(channelId).add(ws);
    // 연결 즉시 현재 스케줄 전송
    channelBroadcastState.set(channelId, getChannelResolvedStateKey(channelId));
    ws.send(JSON.stringify(buildPlayerUpdatePayload(channelId)));
    slog('ws_connect', { channelId, total: channelClients.get(channelId).size }, 'system');
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
      if (msg.type === 'ping') {
        if (ws.duid) {
          const entry = activePlayers.get(ws.duid);
          if (entry) entry.lastSeen = Date.now();
        }
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      } else if (msg.type === 'heartbeat') {
        if (!ws.duid) return;
        const entry = activePlayers.get(ws.duid);
        if (!entry) return;
        entry.lastSeen = Date.now();
        entry.lastHeartbeatAt = Date.now();
        entry.channelId = ws.channelId || msg.player?.channelId || entry.channelId || null;
        entry.player = {
          mode: msg.player?.mode || 'schedule',
          playback: msg.player?.playback || 'unknown',
          currentType: msg.player?.currentType || null,
          currentFilename: msg.player?.currentFilename || null,
          streamUrl: msg.player?.streamUrl || null,
          playbackProfile: normalizePlaybackProfile(msg.player?.playbackProfile),
          syncTargetEpochMs: Number.isFinite(Number(msg.player?.syncTargetEpochMs)) ? Number(msg.player.syncTargetEpochMs) : null,
          queueSize: Number.isInteger(msg.player?.queueSize) ? msg.player.queueSize : null,
          itemIndex: Number.isInteger(msg.player?.itemIndex) ? msg.player.itemIndex : null,
          lastError: msg.player?.lastError || null,
          ts: Number.isFinite(msg.ts) ? msg.ts : Date.now()
        };
      }
    } catch {}
  });

  ws.on('close', () => {
    if (ws.duid) {
      activePlayers.delete(ws.duid);
      slog('player_disconnect', { duid: ws.duid }, 'system');
    }
    if (ws.channelId && channelClients.has(ws.channelId)) {
      channelClients.get(ws.channelId).delete(ws);
      slog('ws_disconnect', { channelId: ws.channelId, remaining: channelClients.get(ws.channelId).size }, 'system');
    }
  });
});

// heartbeat가 끊긴 세션을 장시간 유지하지 않도록 정리
setInterval(() => {
  const now = Date.now();
  for (const [duid, info] of activePlayers) {
    if (!info.lastHeartbeatAt) continue;
    if (now - info.lastHeartbeatAt <= PLAYER_HEARTBEAT_STALE_MS * 3) continue;
    if (info.ws?.readyState === WebSocket.OPEN) {
      try { info.ws.terminate(); } catch {}
    }
    activePlayers.delete(duid);
  }
}, 15000);

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
//  MDC 상태 자동 폴링 (30초 주기)
// ═══════════════════════════════════════════════
setTimeout(pollAllMdcStatus, 10000);   // 서버 시작 10초 후 첫 폴링
setInterval(pollAllMdcStatus, 30000);  // 이후 30초마다

// 채널 규칙(시간/우선순위) 자동 전환 감시
setTimeout(refreshAllChannelsByRules, 5000);
setInterval(refreshAllChannelsByRules, 15000);
reconcileDesignerSourceMediaHiddenState();

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
server.listen(PORT);
