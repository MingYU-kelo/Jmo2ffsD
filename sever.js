const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8765;
const BIND = process.env.BIND || '0.0.0.0';
const API_BASE = 'https://cshvh.cn';
const STATIC_DIR = __dirname;
const CACHE_FILE = path.join(__dirname, 'cache.json');
const TIMELINE_FILE = path.join(__dirname, 'timeline.json');
const PAGE_SIZE = 10;
const CONCURRENCY = 5;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

// --- Rate limiter (simple sliding window per IP) ---
const RATE_WINDOW_MS = 60000;
const RATE_MAX_REQUESTS = 300;
const rateMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entries] of rateMap) {
    const filtered = entries.filter((t) => now - t < RATE_WINDOW_MS);
    if (filtered.length === 0) rateMap.delete(ip);
    else rateMap.set(ip, filtered);
  }
}, 60000);

function checkRateLimit(ip) {
  const now = Date.now();
  let entries = rateMap.get(ip);
  if (!entries) {
    entries = [];
    rateMap.set(ip, entries);
  }
  entries.push(now);
  const recent = entries.filter((t) => now - t < RATE_WINDOW_MS);
  rateMap.set(ip, recent);
  return recent.length <= RATE_MAX_REQUESTS;
}

// --- Security: path traversal protection ---
function safePath(requestPath) {
  if (requestPath === '/' || requestPath === '') {
    return path.join(STATIC_DIR, 'index.html');
  }
  // Reject paths with null bytes, control chars, or suspicious patterns
  if (/[\x00-\x1f]|\.\.\/|\.\.\\|~|%2e%2e|%2f|%5c/i.test(requestPath)) {
    return null;
  }
  const clean = requestPath.split('?')[0].split('#')[0];
  const resolved = path.resolve(STATIC_DIR, '.' + clean);
  if (!resolved.startsWith(STATIC_DIR + path.sep) && resolved !== STATIC_DIR) {
    return null;
  }
  return resolved;
}

// --- Security: validate proxy path ---
const ALLOWED_PROXY_PREFIXES = [
  '/endpoint/top/user/',
  '/endpoint/top/user',
  '/endpoint/top/guild/',
  '/endpoint/top/guild',
  '/endpoint/user/userInfo',
];

function isAllowedProxyPath(apiPath) {
  for (const prefix of ALLOWED_PROXY_PREFIXES) {
    if (apiPath === prefix || apiPath.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

// --- Cache system ---
let cache = {
  dates: [],
  guildDates: [],
  months: {},
  guildMonths: {},
  lastSync: null,
};

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log('[cache] saved to disk');
  } catch (e) {
    console.error('[cache] save error:', e.message);
  }
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.dates && parsed.months) {
        cache = parsed;
        if (!cache.guildMonths) cache.guildMonths = {};
        if (!cache.guildDates) cache.guildDates = [];
        const userMonths = Object.keys(cache.months).length;
        const guildMonths = Object.keys(cache.guildMonths).length;
        console.log(`[cache] loaded: ${cache.dates.length} user dates (${userMonths} mo), ${(cache.guildDates || []).length} guild dates (${guildMonths} mo)`);
        return;
      }
    }
  } catch (e) {
    console.error('[cache] load error:', e.message);
  }
  console.log('[cache] starting fresh');
}

// --- Guild Timeline ---
let timeline = {};

function loadTimeline() {
  try {
    if (fs.existsSync(TIMELINE_FILE)) {
      timeline = JSON.parse(fs.readFileSync(TIMELINE_FILE, 'utf8'));
      console.log(`[timeline] loaded: ${Object.keys(timeline).length} users tracked`);
    }
  } catch (e) {
    console.error('[timeline] load error:', e.message);
    timeline = {};
  }
}

function saveTimeline() {
  try {
    fs.writeFileSync(TIMELINE_FILE, JSON.stringify(timeline, null, 2));
  } catch (e) {
    console.error('[timeline] save error:', e.message);
  }
}

function getGuildForMonth(uid, ym) {
  const segments = timeline[String(uid)];
  if (!segments || segments.length === 0) return null;
  for (const seg of segments) {
    if (ym >= seg.from && (!seg.to || ym <= seg.to)) {
      return { guildId: seg.guildId, guildName: seg.guildName };
    }
  }
  return null;
}

function updateTimeline(uid, guildId, guildName, ym) {
  const key = String(uid);
  if (!timeline[key]) timeline[key] = [];

  const segs = timeline[key];
  const last = segs[segs.length - 1];

  if (!last) {
    if (guildId) {
      segs.push({ guildId, guildName, from: getEarliestMonth(), to: null });
    }
    return !!guildId;
  }

  // User definitely has no guild now — close old segment
  if (!guildId) {
    const prevMonth = getPrevMonth(ym);
    if (last.to === null && prevMonth >= last.from) {
      last.to = prevMonth;
      return true;
    }
    return false;
  }

  // Same guild
  if (last.guildId === guildId) {
    if (guildName && last.guildName !== guildName) last.guildName = guildName;
    return false;
  }

  // Different guild — close old, start new
  const prevMonth = getPrevMonth(ym);
  if (last.to === null && prevMonth >= last.from) last.to = prevMonth;
  segs.push({ guildId, guildName, from: ym, to: null });
  return true;
}

function getEarliestMonth() {
  const months = Object.keys(cache.months).sort();
  return months[0] || '2025-01';
}

function getPrevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// Rebuild guild members using timeline (no API calls)
async function rebuildGuildMembersForMonth(ym) {
  const userMonth = cache.months[ym];
  if (!userMonth || !userMonth.users || userMonth.users.length === 0) return;

  const guildMap = new Map();
  let assigned = 0, unassigned = 0;

  for (const u of userMonth.users) {
    const uid = u.id;
    if (!uid) { unassigned++; continue; }
    const g = getGuildForMonth(uid, ym);
    if (!g) { unassigned++; continue; }
    assigned++;

    if (!guildMap.has(g.guildId)) {
      guildMap.set(g.guildId, {
        guildId: g.guildId, guildName: g.guildName,
        logoUrl: null, memberCount: 0, users: [],
        totalKill: 0, totalDeath: 0, totalScore: 0,
      });
    }
    const gm = guildMap.get(g.guildId);
    gm.users.push({
      uid: u.id, userName: u.userName,
      kills: u.totalKill || 0, deaths: u.totalDeath || 0,
      kd: u.totalDeath > 0 ? u.totalKill / u.totalDeath : 0,
      score: u.totalScore || 0,
    });
    gm.totalKill += u.totalKill || 0;
    gm.totalDeath += u.totalDeath || 0;
    gm.totalScore += u.totalScore || 0;
  }

  const guilds = [...guildMap.values()]
    .sort((a, b) => b.users.length - a.users.length)
    .map(g => ({ ...g, avgKd: g.totalDeath > 0 ? (g.totalKill / g.totalDeath).toFixed(2) : '0.00' }));

  if (!cache.guildMonths[ym]) cache.guildMonths[ym] = {};
  cache.guildMonths[ym].guildMembers = guilds;
  console.log(`[rebuild] ${ym}: ${assigned} assigned to ${guilds.length} guilds, ${unassigned} unassigned`);
}

// --- API helpers ---
function fetchJSON(apiPath) {
  return new Promise((resolve, reject) => {
    const targetUrl = API_BASE + apiPath;
    const parsed = new URL(targetUrl);

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let body = [];
      res.on('data', (chunk) => body.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(body).toString());
          if (data.code !== 200) {
            reject(new Error(data.msg || 'API error'));
            return;
          }
          resolve(data.data);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function fetchDailyRanking(date, pageNum = 1) {
  return fetchJSON(`/endpoint/top/user/history?type=4&date=${date}&pageNum=${pageNum}&pageSize=${PAGE_SIZE}`);
}

async function fetchAllPagesForDate(date) {
  const first = await fetchDailyRanking(date, 1);
  if (first.total <= PAGE_SIZE) return first.rows;

  const totalPages = Math.ceil(first.total / PAGE_SIZE);
  const allRows = [...first.rows];

  for (let page = 2; page <= totalPages; page += CONCURRENCY) {
    const batch = [];
    for (let p = page; p < page + CONCURRENCY && p <= totalPages; p++) {
      batch.push(fetchDailyRanking(date, p));
    }
    const results = await Promise.all(batch);
    for (const r of results) {
      allRows.push(...r.rows);
    }
    if (page + CONCURRENCY <= totalPages) {
      await sleep(300);
    }
  }

  return allRows;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGuildDailyRanking(date, pageNum = 1) {
  return fetchJSON(`/endpoint/top/guild/history?type=4&date=${date}&pageNum=${pageNum}&pageSize=${PAGE_SIZE}`);
}

async function fetchAllGuildPagesForDate(date) {
  const first = await fetchGuildDailyRanking(date, 1);
  if (first.total <= PAGE_SIZE) return first.rows;

  const totalPages = Math.ceil(first.total / PAGE_SIZE);
  const allRows = [...first.rows];

  for (let page = 2; page <= totalPages; page += CONCURRENCY) {
    const batch = [];
    for (let p = page; p < page + CONCURRENCY && p <= totalPages; p++) {
      batch.push(fetchGuildDailyRanking(date, p));
    }
    const results = await Promise.all(batch);
    for (const r of results) {
      allRows.push(...r.rows);
    }
    if (page + CONCURRENCY <= totalPages) {
      await sleep(300);
    }
  }

  return allRows;
}

// --- User info ---
async function fetchUserInfo(uid) {
  return fetchJSON(`/endpoint/user/userInfo?uid=${uid}`);
}

// --- Sync worker ---
let syncRunning = false;

async function syncOneType(type, getDatesPath, getHistoryFn, cacheKey, idField, nameField, scoreField) {
  const allDates = await fetchJSON(getDatesPath);
  if (cacheKey === 'dates') cache.dates = allDates;
  else cache.guildDates = allDates;

  const monthMap = new Map();
  for (const d of allDates) {
    const ym = d.substring(0, 7);
    if (!monthMap.has(ym)) monthMap.set(ym, []);
    monthMap.get(ym).push(d);
  }

  const store = cacheKey === 'dates' ? cache.months : cache.guildMonths;

  for (const [ym, dates] of monthMap) {
    const sortedDates = dates.sort();
    const cached = store[ym];

    let datesToFetch;
    if (!cached) {
      datesToFetch = sortedDates;
    } else {
      const cachedDates = new Set(cached.dates || []);
      datesToFetch = sortedDates.filter((d) => !cachedDates.has(d));
    }

    if (datesToFetch.length === 0) continue;

    console.log(`[sync-${type}] ${ym}: ${datesToFetch.length} new dates`);

    const rowMap = new Map();
    if (cached && cached.users) {
      for (const u of cached.users) {
        rowMap.set(String(u[idField]), { ...u });
      }
    }

    const syncedDates = cached ? new Set(cached.dates || []) : new Set();
    let totalEntries = cached ? cached.totalEntries || 0 : 0;

    for (let i = 0; i < datesToFetch.length; i++) {
      const date = datesToFetch[i];
      try {
        const rows = await getHistoryFn(date);
        totalEntries += rows.length;

        for (const row of rows) {
          const key = String(row[idField]);
          if (!rowMap.has(key)) {
            rowMap.set(key, {
              [idField]: row[idField],
              [nameField]: row[nameField],
              avatarUrl: row.avatarUrl || null,
              logoUrl: row.logoUrl || null,
              ownerName: row.ownerName || null,
              ownerId: row.ownerId || null,
              appearances: 0,
              totalScore: 0,
              totalKill: 0,
              totalDeath: 0,
            });
          }
          const u = rowMap.get(key);
          u.appearances++;
          u.totalScore += row[scoreField] || 0;
          u.totalKill += parseInt(row.kill) || 0;
          u.totalDeath += parseInt(row.death) || 0;
        }

        syncedDates.add(date);

        // Avoid hitting the API too fast between dates
        if (i < datesToFetch.length - 1) {
          await sleep(1500 + Math.random() * 1000);
        }
      } catch (e) {
        console.error(`[sync-${type}] error ${date}:`, e.message);
      }

      if ((i + 1) % 5 === 0) {
        console.log(`[sync-${type}] ${ym}: ${i + 1}/${datesToFetch.length}`);
      }
    }

    const rows = [...rowMap.values()].sort((a, b) => b.totalScore - a.totalScore);
    store[ym] = {
      dates: [...syncedDates],
      totalEntries,
      userCount: rows.length,
      users: rows,
      syncedAt: new Date().toISOString(),
    };

    console.log(`[sync-${type}] ${ym}: ${rows.length} entries, ${totalEntries} total`);
  }
}

async function syncCache() {
  if (syncRunning) {
    console.log('[sync] already running, skipping');
    return;
  }
  syncRunning = true;
  console.log('[sync] starting...');

  try {
    // Sync user rankings
    await syncOneType(
      'user', '/endpoint/top/user/history/dates?type=4',
      fetchAllPagesForDate, 'dates', 'id', 'userName', 'userScore'
    );

    // Sync guild rankings
    await syncOneType(
      'guild', '/endpoint/top/guild/history/dates?type=4',
      fetchAllGuildPagesForDate, 'guildDates', 'guildId', 'guildName', 'guildScore'
    );

    // Update timeline by sampling users from latest month
    const months = Object.keys(cache.months).sort().reverse();
    const latest = months[0];
    if (latest && cache.months[latest] && cache.months[latest].users) {
      console.log(`[sync] refreshing timeline from ${latest}`);
      const users = cache.months[latest].users;
      buildProgress = { current: latest, done: 0, total: months.length, months, monthUsers: users.length, monthDone: 0 };

      for (let i = 0; i < users.length; i++) {
        try {
          const info = await fetchUserInfo(users[i].id);
          if (info) {
            if (info.guild) {
              updateTimeline(users[i].id, info.guild.guildId, info.guild.name, latest);
            } else {
              // User has no guild — close timeline segment
              updateTimeline(users[i].id, null, null, latest);
            }
          }
          // API error: skip, keep old record
        } catch (e) {}
        buildProgress.monthDone = i + 1;
        if ((i + 1) % 50 === 0) saveTimeline();
        if (i < users.length - 1) await sleep(500 + Math.random() * 500);
      }
      saveTimeline();
    }

    // Rebuild all months from timeline
    buildProgress = { current: null, done: 0, total: months.length, months, monthUsers: 0, monthDone: 0 };
    for (const ym of months) {
      buildProgress.current = ym;
      buildProgress.done++;

      await rebuildGuildMembersForMonth(ym);
    }
    saveCache();

    buildProgress.current = null;

    cache.lastSync = new Date().toISOString();
    saveCache();
    console.log('[sync] complete');
  } catch (e) {
    console.error('[sync] error:', e.message);
  } finally {
    syncRunning = false;
  }
}

// --- Schedule 4 AM daily ---
function scheduleNextSync() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(23, 0, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  const ms = next.getTime() - now.getTime();
  console.log(`[sync] next sync at ${next.toLocaleString()} (in ${Math.round(ms / 60000)} min)`);

  setTimeout(() => {
    syncCache().then(() => {
      // After first 4 AM sync, schedule every 24h
      setInterval(() => {
        syncCache();
      }, 24 * 60 * 60 * 1000);
    });
  }, ms);
}

// --- Server ---
function serveStatic(req, res) {
  const filePath = safePath(req.url);

  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Cache-Control': 'public, max-age=600',
    });
    res.end(data);
  });
}

function proxyAPI(req, res) {
  const apiPath = req.url.slice(4); // Remove /api prefix

  if (!isAllowedProxyPath(apiPath)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }

  const targetUrl = API_BASE + apiPath;
  const parsed = new URL(targetUrl);

  const options = {
    hostname: parsed.hostname,
    port: 443,
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    },
    timeout: 30000,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let body = [];
    proxyRes.on('data', (chunk) => body.push(chunk));
    proxyRes.on('end', () => {
      const data = Buffer.concat(body);
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      });
      res.end(data);
    });
  });

  proxyReq.on('error', () => {
    res.writeHead(502, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: 'upstream error' }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: 'upstream timeout' }));
  });

  proxyReq.end();
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  // Rate limit
  const ip = getClientIP(req);
  if (!checkRateLimit(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('429 Too Many Requests');
    return;
  }

  // Routing
  if (req.url === '/api/cached/build-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildProgress));
    return;
  }

  if (req.url === '/api/cached/overview') {
    const months = {};
    for (const [ym, data] of Object.entries(cache.months)) {
      months[ym] = {
        days: data.dates.length,
        totalEntries: data.totalEntries,
        userCount: data.userCount,
      };
    }
    const guildMonths = {};
    for (const [ym, data] of Object.entries(cache.guildMonths || {})) {
      guildMonths[ym] = {
        days: data.dates.length,
        totalEntries: data.totalEntries,
        userCount: data.userCount,
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ lastSync: cache.lastSync, months, guildMonths }));
    return;
  }

  if (req.url.startsWith('/api/cached/month/')) {
    const ym = req.url.slice('/api/cached/month/'.length).split('?')[0];
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid month format' }));
      return;
    }
    const data = cache.months[ym];
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (req.url.startsWith('/api/cached/guild/month/')) {
    const ym = req.url.slice('/api/cached/guild/month/'.length).split('?')[0];
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid month format' }));
      return;
    }
    const data = (cache.guildMonths || {})[ym];
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (req.url.startsWith('/api/cached/guild/members/')) {
    const ym = req.url.slice('/api/cached/guild/members/'.length).split('?')[0];
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid month format' }));
      return;
    }

    const guildMonth = cache.guildMonths[ym] || {};
    if (guildMonth.guildMembers) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(guildMonth.guildMembers));
      return;
    }

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pending: true, msg: '公会成员数据尚未生成，请在凌晨4点同步后查看' }));
    return;
  }

  if (req.url.startsWith('/api/')) {
    proxyAPI(req, res);
    return;
  }

  // Only allow known static files for GET
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('405 Method Not Allowed');
    return;
  }

  serveStatic(req, res);
});

// --- Startup ---
loadCache();
loadTimeline();
scheduleNextSync();

// Run initial sync if cache is empty or stale (more than 24h old)
const cacheAge = cache.lastSync ? Date.now() - new Date(cache.lastSync).getTime() : Infinity;
const guildEmpty = !cache.guildMonths || Object.keys(cache.guildMonths).length === 0;
if (!cache.lastSync || cacheAge > 24 * 60 * 60 * 1000 || guildEmpty) {
  console.log('[sync] cache needs update, running sync');
  syncCache();
}

// Populate timeline & rebuild all months (runs after sync/startup)
setTimeout(async () => {
  const months = Object.keys(cache.months).sort().reverse();
  if (months.length === 0) return;

  // Step 1: Build timeline from current month's userInfo
  const latest = months[0];
  const tlEmpty = Object.keys(timeline).length === 0;

  if (tlEmpty && cache.months[latest] && cache.months[latest].users) {
    console.log(`[timeline] initial populate from ${latest} (${cache.months[latest].users.length} users)`);
    buildProgress = { current: latest, done: 0, total: months.length, months, monthUsers: cache.months[latest].users.length, monthDone: 0 };

    for (let i = 0; i < cache.months[latest].users.length; i++) {
      const u = cache.months[latest].users[i];
      try {
        const info = await fetchUserInfo(u.id);
        if (info) {
          if (info.guild) {
            updateTimeline(u.id, info.guild.guildId, info.guild.name, latest);
          } else {
            updateTimeline(u.id, null, null, latest);
          }
        }
      } catch (e) {}

      buildProgress.monthDone = i + 1;

      if ((i + 1) % 50 === 0) saveTimeline();
      if (i < cache.months[latest].users.length - 1) {
        await sleep(500 + Math.random() * 500);
      }
    }
    saveTimeline();
    console.log(`[timeline] initial done: ${Object.keys(timeline).length} users tracked`);
  }

  // Step 2: Rebuild all months from timeline (fast, no API calls)
  buildProgress = { current: null, done: 0, total: months.length, months, monthUsers: 0, monthDone: 0 };
  for (const ym of months) {
    buildProgress.current = ym;
    buildProgress.done++;

    await rebuildGuildMembersForMonth(ym);
    saveCache();
  }

  buildProgress.current = null;
  console.log('[startup] all guild members rebuilt from timeline');
}, 15000);

server.listen(PORT, BIND, () => {
  console.log(`Server running at http://${BIND}:${PORT}`);
});
