const http = require('http');
const fs = require('fs');
const path = require('path');

const API_BASE = process.env.PROXY_API || 'https://cshvh.cn';
const DATA_DIR = path.join(__dirname, '..', 'data');
const MONTHLY_DIR = path.join(DATA_DIR, 'monthly');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const PAGE_SIZE = 10;
const CONCURRENCY = 1;

// --- Helpers ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJSON(apiPath, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await doFetchJSON(apiPath);
    } catch (e) {
      if (attempt === retries) throw e;
      const wait = Math.pow(2, attempt) * 2000;
      console.error(`[fetch] retry ${attempt + 1}/${retries} in ${wait / 1000}s: ${e.message}`);
      await sleep(wait);
    }
  }
}

function doFetchJSON(apiPath) {
  return new Promise((resolve, reject) => {
    const targetUrl = API_BASE + apiPath;
    const parsed = new URL(targetUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://cshvh.cn/',
      },
      timeout: 30000,
    };
    const req = http.request(options, (res) => {
      let body = [];
      res.on('data', (chunk) => body.push(chunk));
      res.on('end', () => {
        try {
          const text = Buffer.concat(body).toString();
          if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
            reject(new Error(`API returned HTML (status ${res.statusCode}), possibly blocked`));
            return;
          }
          const data = JSON.parse(text);
          if (data.code !== 200) { reject(new Error(data.msg || 'API error')); return; }
          resolve(data.data);
        } catch (e) { reject(e); }
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
    for (const r of results) allRows.push(...r.rows);
    if (page + CONCURRENCY <= totalPages) await sleep(300);
  }
  return allRows;
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
    for (const r of results) allRows.push(...r.rows);
    if (page + CONCURRENCY <= totalPages) await sleep(300);
  }
  return allRows;
}

async function fetchUserInfo(uid) {
  return fetchJSON(`/endpoint/user/userInfo?uid=${uid}`);
}

// --- Data loading ---
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) { console.error(`[load] error ${filePath}:`, e.message); }
  return null;
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function ensureDailyDir(type, ym) {
  const dir = path.join(DAILY_DIR, type, ym);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveDailyIfNew(type, date, rows) {
  const ym = date.substring(0, 7);
  const dir = ensureDailyDir(type, ym);
  const prefix = type === 'user' ? 'user-' : 'guild-';
  const file = path.join(dir, `${prefix}${date}.json`);
  if (!fs.existsSync(file)) {
    saveJson(file, { date, type, syncedAt: new Date().toISOString(), rows });
  }
}

function dailyFileExists(type, date) {
  const ym = date.substring(0, 7);
  const prefix = type === 'user' ? 'user-' : 'guild-';
  return fs.existsSync(path.join(DAILY_DIR, type, ym, `${prefix}${date}.json`));
}

// Load existing per-month data, or migrate from legacy cache.json
function loadExistingData() {
  ensureDataDir();

  const userDir = path.join(MONTHLY_DIR, 'user');
  const guildDir = path.join(MONTHLY_DIR, 'guild');
  const guildMembersDir = path.join(MONTHLY_DIR, 'guild-members');

  const overview = loadJson(path.join(DATA_DIR, 'overview.json'));
  const timeline = loadJson(path.join(DATA_DIR, 'timeline.json'));

  // Check if we already have per-month files in new structure
  const existing = fs.existsSync(userDir) ? fs.readdirSync(userDir).filter(f => /^\d{4}-\d{2}\.json$/.test(f)) : [];

  if (existing.length > 0 && overview) {
    console.log(`[load] found ${existing.length} month files, overview, timeline`);
    const months = {};
    const guildMonths = {};
    for (const f of existing) {
      const ym = f.replace('.json', '');
      months[ym] = loadJson(path.join(userDir, f));
    }
    if (fs.existsSync(guildDir)) {
      for (const f of fs.readdirSync(guildDir).filter(f => /^guild-\d{4}-\d{2}\.json$/.test(f))) {
        const ym = f.replace('guild-', '').replace('.json', '');
        guildMonths[ym] = loadJson(path.join(guildDir, f));
      }
    }
    if (fs.existsSync(guildMembersDir)) {
      for (const f of fs.readdirSync(guildMembersDir).filter(f => /^guild-members-\d{4}-\d{2}\.json$/.test(f))) {
        const ym = f.replace('guild-members-', '').replace('.json', '');
        if (!guildMonths[ym]) guildMonths[ym] = {};
        guildMonths[ym].guildMembers = loadJson(path.join(guildMembersDir, f));
      }
    }
    return { dates: overview.dates || [], guildDates: overview.guildDates || [], months, guildMonths, lastSync: overview.lastSync, timeline: timeline || {} };
  }

  // Migrate from legacy cache.json
  const cache = loadJson(path.join(__dirname, '..', 'cache.json'));
  const oldTimeline = loadJson(path.join(__dirname, '..', 'timeline.json'));
  if (cache && cache.months) {
    console.log('[load] migrating from legacy cache.json');
    if (!cache.guildMonths) cache.guildMonths = {};
    if (!cache.guildDates) cache.guildDates = [];
    return { dates: cache.dates || [], guildDates: cache.guildDates || [], months: cache.months, guildMonths: cache.guildMonths, lastSync: cache.lastSync, timeline: oldTimeline || {} };
  }

  console.log('[load] starting fresh');
  return { dates: [], guildDates: [], months: {}, guildMonths: {}, lastSync: null, timeline: {} };
}

// --- Timeline ---
function getEarliestMonth(months) {
  const keys = Object.keys(months).sort();
  return keys[0] || '2025-01';
}

function getPrevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function getGuildForMonth(timeline, uid, ym) {
  const segments = timeline[String(uid)];
  if (!segments || segments.length === 0) return null;
  for (const seg of segments) {
    if (ym >= seg.from && (!seg.to || ym <= seg.to)) {
      return { guildId: seg.guildId, guildName: seg.guildName };
    }
  }
  return null;
}

function updateTimeline(timeline, uid, guildId, guildName, ym, months) {
  const key = String(uid);
  if (!timeline[key]) timeline[key] = [];
  const segs = timeline[key];
  const last = segs[segs.length - 1];

  if (!last) {
    if (guildId) {
      segs.push({ guildId, guildName, from: getEarliestMonth(months), to: null });
    }
    return !!guildId;
  }

  if (!guildId) {
    const prevMonth = getPrevMonth(ym);
    if (last.to === null && prevMonth >= last.from) {
      last.to = prevMonth;
      return true;
    }
    return false;
  }

  if (last.guildId === guildId) {
    if (guildName && last.guildName !== guildName) last.guildName = guildName;
    return false;
  }

  const prevMonth = getPrevMonth(ym);
  if (last.to === null && prevMonth >= last.from) last.to = prevMonth;
  segs.push({ guildId, guildName, from: ym, to: null });
  return true;
}

// --- Rebuild guild members ---
function rebuildGuildMembersForMonth(months, guildMonths, timeline, ym) {
  const userMonth = months[ym];
  if (!userMonth || !userMonth.users || userMonth.users.length === 0) return;

  const guildMap = new Map();
  let assigned = 0, unassigned = 0;

  for (const u of userMonth.users) {
    const uid = u.id;
    if (!uid) { unassigned++; continue; }
    const g = getGuildForMonth(timeline, uid, ym);
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

  if (!guildMonths[ym]) guildMonths[ym] = {};
  guildMonths[ym].guildMembers = guilds;
  console.log(`[rebuild] ${ym}: ${assigned} assigned, ${unassigned} unassigned`);
}

// --- Save all data ---
function saveAllData(dates, guildDates, months, guildMonths, lastSync, timeline) {
  ensureDataDir();

  const userDir = path.join(MONTHLY_DIR, 'user');
  const guildDir = path.join(MONTHLY_DIR, 'guild');
  const guildMembersDir = path.join(MONTHLY_DIR, 'guild-members');
  for (const d of [userDir, guildDir, guildMembersDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  // Save per-month user files
  const monthFiles = new Map();
  for (const [ym, data] of Object.entries(months)) {
    const file = path.join(userDir, `${ym}.json`);
    saveJson(file, data);
    monthFiles.set(`${ym}.json`, userDir);
  }

  // Save per-month guild files
  for (const [ym, data] of Object.entries(guildMonths)) {
    const guildMembers = data.guildMembers;
    const guildData = { ...data };
    delete guildData.guildMembers;
    if (Object.keys(guildData).length > 0) {
      const file = path.join(guildDir, `guild-${ym}.json`);
      saveJson(file, guildData);
      monthFiles.set(`guild-${ym}.json`, guildDir);
    }
    if (guildMembers) {
      const file = path.join(guildMembersDir, `guild-members-${ym}.json`);
      saveJson(file, guildMembers);
      monthFiles.set(`guild-members-${ym}.json`, guildMembersDir);
    }
  }

  // Clean up old month files that no longer exist
  for (const dir of [userDir, guildDir, guildMembersDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!monthFiles.has(f)) {
        fs.unlinkSync(path.join(dir, f));
        console.log(`[cleanup] removed monthly/${path.basename(dir)}/${f}`);
      }
    }
  }

  // Save overview
  const overviewMonths = {};
  for (const [ym, data] of Object.entries(months)) {
    overviewMonths[ym] = { days: data.dates.length, totalEntries: data.totalEntries, userCount: data.userCount };
  }
  const overviewGuildMonths = {};
  for (const [ym, data] of Object.entries(guildMonths)) {
    overviewGuildMonths[ym] = { days: data.dates.length, totalEntries: data.totalEntries, userCount: data.userCount, hasMembers: !!data.guildMembers };
  }
  saveJson(path.join(DATA_DIR, 'overview.json'), { lastSync, dates, guildDates, months: overviewMonths, guildMonths: overviewGuildMonths });

  // Save timeline
  saveJson(path.join(DATA_DIR, 'timeline.json'), timeline);

  console.log(`[save] ${Object.keys(months).length} user months, ${Object.keys(guildMonths).length} guild months`);
}

// --- Main sync ---
async function syncOneType(type, getDatesPath, getHistoryFn, cacheKey, idField, nameField, scoreField, state) {
  const store = cacheKey === 'dates' ? state.months : state.guildMonths;
  const datesKey = cacheKey === 'dates' ? 'dates' : 'guildDates';

  const allDates = await fetchJSON(getDatesPath);
  state[datesKey] = allDates;

  const monthMap = new Map();
  for (const d of allDates) {
    const ym = d.substring(0, 7);
    if (!monthMap.has(ym)) monthMap.set(ym, []);
    monthMap.get(ym).push(d);
  }

  for (const [ym, dates] of monthMap) {
    const sortedDates = dates.sort();
    const cached = store[ym];

    const cachedDates = cached ? new Set(cached.dates || []) : new Set();
    const recent3 = new Set(sortedDates.slice(-3));
    const datesToFetch = sortedDates.filter((d) => {
      if (recent3.has(d)) return true;                          // always refresh last 3 days
      if (!cachedDates.has(d)) return true;                     // new date
      return !dailyFileExists(type, d);                         // missing daily file
    });

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
        saveDailyIfNew(type, date, rows);
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
        if (i < datesToFetch.length - 1) await sleep(1500 + Math.random() * 1000);
      } catch (e) {
        console.error(`[sync-${type}] error ${date}:`, e.message);
      }

      if ((i + 1) % 5 === 0) console.log(`[sync-${type}] ${ym}: ${i + 1}/${datesToFetch.length}`);
    }

    const rows = [...rowMap.values()].sort((a, b) => b.totalScore - a.totalScore);
    store[ym] = {
      dates: [...syncedDates].sort(),
      totalEntries,
      userCount: rows.length,
      users: rows,
      syncedAt: new Date().toISOString(),
    };

    console.log(`[sync-${type}] ${ym}: ${rows.length} entries, ${totalEntries} total`);
  }
}

async function main() {
  console.log('[sync] starting...');
  const state = loadExistingData();

  // Sync user rankings
  await syncOneType(
    'user', '/endpoint/top/user/history/dates?type=4',
    fetchAllPagesForDate, 'dates', 'id', 'userName', 'userScore', state
  );

  // Sync guild rankings
  await syncOneType(
    'guild', '/endpoint/top/guild/history/dates?type=4',
    fetchAllGuildPagesForDate, 'guildDates', 'guildId', 'guildName', 'guildScore', state
  );

  // Update timeline by sampling users from latest month
  const months = Object.keys(state.months).sort().reverse();
  const latest = months[0];
  if (latest && state.months[latest] && state.months[latest].users) {
    console.log(`[sync] refreshing timeline from ${latest} (${state.months[latest].users.length} users)`);
    for (let i = 0; i < state.months[latest].users.length; i++) {
      const u = state.months[latest].users[i];
      try {
        const info = await fetchUserInfo(u.id);
        if (info) {
          if (info.guild) {
            updateTimeline(state.timeline, u.id, info.guild.guildId, info.guild.name, latest, state.months);
          } else {
            updateTimeline(state.timeline, u.id, null, null, latest, state.months);
          }
        }
      } catch (e) {}
      if ((i + 1) % 100 === 0) console.log(`[timeline] ${i + 1}/${state.months[latest].users.length}`);
      if (i < state.months[latest].users.length - 1) await sleep(500 + Math.random() * 500);
    }
    console.log(`[timeline] done: ${Object.keys(state.timeline).length} users tracked`);
  }

  // Rebuild guild members for all months
  for (const ym of months) {
    rebuildGuildMembersForMonth(state.months, state.guildMonths, state.timeline, ym);
  }

  state.lastSync = new Date().toISOString();

  // Save everything
  saveAllData(state.dates, state.guildDates, state.months, state.guildMonths, state.lastSync, state.timeline);

  console.log('[sync] complete');
}

main().catch(e => { console.error(e); process.exit(1); });
