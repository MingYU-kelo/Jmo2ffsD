// One-time migration: converts legacy cache.json + timeline.json into per-month data/ files
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const cache = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache.json'), 'utf8'));
let timeline = {};
try {
  timeline = JSON.parse(fs.readFileSync(path.join(ROOT, 'timeline.json'), 'utf8'));
} catch (e) {}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Save per-month user files
for (const [ym, data] of Object.entries(cache.months || {})) {
  fs.writeFileSync(path.join(DATA_DIR, `${ym}.json`), JSON.stringify(data));
  console.log(`  user ${ym}: ${data.dates.length} days, ${data.users.length} users`);
}

// Save per-month guild files
for (const [ym, data] of Object.entries(cache.guildMonths || {})) {
  const { guildMembers, ...guildData } = data;
  fs.writeFileSync(path.join(DATA_DIR, `guild-${ym}.json`), JSON.stringify(guildData));
  if (guildMembers) {
    fs.writeFileSync(path.join(DATA_DIR, `guild-members-${ym}.json`), JSON.stringify(guildMembers));
  }
  console.log(`  guild ${ym}: ${data.dates.length} days, ${data.userCount} entries, ${guildMembers ? guildMembers.length : 0} members`);
}

// Build overview
const overviewMonths = {};
for (const [ym, data] of Object.entries(cache.months || {})) {
  overviewMonths[ym] = { days: data.dates.length, totalEntries: data.totalEntries, userCount: data.userCount };
}
const overviewGuildMonths = {};
for (const [ym, data] of Object.entries(cache.guildMonths || {})) {
  overviewGuildMonths[ym] = { days: data.dates.length, totalEntries: data.totalEntries, userCount: data.userCount, hasMembers: !!data.guildMembers };
}
fs.writeFileSync(path.join(DATA_DIR, 'overview.json'), JSON.stringify({
  lastSync: cache.lastSync,
  dates: cache.dates || [],
  guildDates: cache.guildDates || [],
  months: overviewMonths,
  guildMonths: overviewGuildMonths,
}));

// Save timeline
fs.writeFileSync(path.join(DATA_DIR, 'timeline.json'), JSON.stringify(timeline));

console.log(`\nDone: ${Object.keys(cache.months || {}).length} user months, ${Object.keys(cache.guildMonths || {}).length} guild months`);
