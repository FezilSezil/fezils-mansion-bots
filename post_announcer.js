// Следит за новыми постами на Patreon и Boosty и шлёт анонс в канал Discord.
// Зависимостей нет, нужен только Node.js 18+.
// Запуск:        node post_announcer.js
// Проверка:      node post_announcer.js --test   (отправит в канал последний пост с каждой площадки)
//
// .env рядом со скриптом (см. .env.example):
//   DISCORD_WEBHOOK_URL=ссылка_вебхука_канала_announcement
//   BOOSTY_BLOG=fezil
//   PATREON_URL=https://www.patreon.com/c/Fezil
//   PATREON_ROLE_ID=             (необязательно: id роли, которую пинговать при посте на Patreon)
//   BOOSTY_ROLE_ID=              (необязательно: id роли, которую пинговать при посте на Boosty)
//   PATREON_CAMPAIGN_ID=         (необязательно: если скрипт сам не найдёт кампанию)
// Имя и аватарка анонсов берутся из настроек самого вебхука в Discord.

const fs = require('fs');
const path = require('path');

// ---------- настройки ----------
const ENV_FILE = path.join(__dirname, '.env');
loadEnv(ENV_FILE);
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
let WEBHOOK = (process.env.DISCORD_WEBHOOK_URL || '').trim();
const BOOSTY_BLOG = process.env.BOOSTY_BLOG || 'fezil';
const PATREON_URL = process.env.PATREON_URL || 'https://www.patreon.com/c/Fezil';
// Роли на сервере Fezil's Mansion, которые участники берут сами, чтобы получать пинг о новых базах
const ROLE_IDS = {
  patreon: (process.env.PATREON_ROLE_ID || '1553373864879202424').trim(),
  boosty:  (process.env.BOOSTY_ROLE_ID  || '1553373934475546824').trim(),
};
const CHECK_EVERY_MS = 5 * 60 * 1000; // раз в 5 минут
const STATE_FILE = path.join(__dirname, 'seen_posts.json');
const LOCK = path.join(__dirname, 'announcer.lock');
const TEST = process.argv.includes('--test');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

if (typeof fetch !== 'function') {
  console.error('Нужен Node.js 18 или новее (node -v). Обнови Node с nodejs.org.');
  process.exit(1);
}

// ---------- Boosty ----------
async function getBoostyPosts() {
  const r = await fetch(`https://api.boosty.to/v1/blog/${BOOSTY_BLOG}/post/?limit=10`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Boosty ответил ${r.status}`);
  const j = await r.json();
  return (j.data || [])
    .filter(p => p.isPublished !== false)
    .map(p => ({
      id: p.id,
      title: p.title || 'New post',
      url: `https://boosty.to/${BOOSTY_BLOG}/posts/${p.id}`,
      image: (p.teaser || []).find(t => t.type === 'image')?.url
          || (p.data || []).find(t => t.type === 'image')?.url || null,
      time: (p.publishTime || p.createdAt || 0) * 1000,
    }));
}

// ---------- Patreon ----------
let patreonCampaignId = (process.env.PATREON_CAMPAIGN_ID || '').trim() || null;

async function findPatreonCampaignId() {
  const r = await fetch(PATREON_URL, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Patreon страница ответила ${r.status}`);
  const html = await r.text();
  const patterns = [
    /"campaign":\{"data":\{"id":"(\d+)"/,
    /\\"campaign\\":\{\\"data\\":\{\\"id\\":\\"(\d+)\\"/,
    /"campaign_id":\s*"?(\d+)/,
    /patreon-media\/p\/campaign\/(\d+)\//,
    /\/api\/campaigns\/(\d+)/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  throw new Error('Не нашёл id кампании Patreon на странице. Впиши PATREON_CAMPAIGN_ID в .env вручную.');
}

async function getPatreonPosts() {
  if (!patreonCampaignId) {
    patreonCampaignId = await findPatreonCampaignId();
    console.log(`Patreon: кампания ${patreonCampaignId}`);
  }
  const url = 'https://www.patreon.com/api/posts'
    + `?filter[campaign_id]=${patreonCampaignId}`
    + '&filter[contains_exclusive_posts]=true'
    + '&filter[is_draft]=false'
    + '&sort=-published_at'
    + '&fields[post]=title,url,published_at,image'
    + '&page[count]=10'
    + '&json-api-version=1.0';
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Content-Type': 'application/vnd.api+json' } });
  if (!r.ok) throw new Error(`Patreon API ответил ${r.status}`);
  const j = await r.json();
  return (j.data || []).map(p => ({
    id: p.id,
    title: p.attributes?.title || 'New post',
    url: p.attributes?.url || `https://www.patreon.com/posts/${p.id}`,
    image: p.attributes?.image?.large_url || p.attributes?.image?.url || null,
    time: Date.parse(p.attributes?.published_at || '') || 0,
  }));
}

// ---------- Discord ----------
const PLATFORMS = {
  boosty:  { name: 'Boosty',  color: 0xF15F2C, fetch: getBoostyPosts },
  patreon: { name: 'Patreon', color: 0xFF424D, fetch: getPatreonPosts },
};

// Текст к анонсу: начало × концовка = 300 разных сочетаний.
// Сочетания не повторяются, пока не будут использованы все (история хранится в seen_posts.json).
const OPENERS = [
  '**{title}** just dropped.',
  'Fresh build on the table: **{title}**.',
  'New base is out. Say hello to **{title}**.',
  '**{title}** is live and ready to be built.',
  'Just finished this one. **{title}** is up now.',
  'Another one for the collection: **{title}**.',
  '**{title}** is officially out of the workshop.',
  'Hot off the blueprint: **{title}**.',
  'New design just landed. Meet **{title}**.',
  '**{title}** is here and ready to go.',
  'Been working on this one for a while. **{title}** is finally out.',
  'Time to grab your hammer. **{title}** is live.',
  'Brand new build: **{title}**.',
  '**{title}** made it out of testing and it is live now.',
  'Something new for your next wipe: **{title}**.',
  'Wipe day plans sorted. **{title}** is up.',
  '**{title}** is ready for its first raid.',
  'Fresh off the build server: **{title}**.',
  'New base alert: **{title}**.',
  '**{title}** just went up. Go take a look.',
];
const CLOSERS = [
  'Grab the code on {platform}.',
  'The full code is waiting for you on {platform}.',
  'Supporters on {platform} can build it right now.',
  'Head over to {platform} to get it.',
  'The code is up on {platform}. See you on wipe.',
  'Check it out on {platform} and tell me how it holds.',
  'Everything you need is on {platform}.',
  'Jump on {platform} and build it before wipe.',
  'It is on {platform} now. Good luck out there.',
  'Build it and tell me what you think.',
  'Available now on {platform}.',
  'Get it on {platform} and send me a screenshot of your build.',
  'On {platform} now. Enjoy the build.',
  'Your next base is one click away on {platform}.',
  'Codes are on {platform}. Have a good wipe.',
];

function pickText(state, title, platformName) {
  const used = new Set(state.usedTexts || []);
  if (used.size >= OPENERS.length * CLOSERS.length) used.clear();
  let i, j;
  do {
    i = Math.floor(Math.random() * OPENERS.length);
    j = Math.floor(Math.random() * CLOSERS.length);
  } while (used.has(`${i}-${j}`));
  used.add(`${i}-${j}`);
  state.usedTexts = [...used];
  const fill = s => s.replace('{title}', title).replace('{platform}', platformName);
  return `${fill(OPENERS[i])}\n${fill(CLOSERS[j])}`;
}

async function announce(platformKey, post, state) {
  const pf = PLATFORMS[platformKey];
  const text = pickText(state, post.title.slice(0, 200), pf.name);
  const roleId = ROLE_IDS[platformKey];
  const body = {
    content: roleId ? `<@&${roleId}>` : '',
    allowed_mentions: { roles: roleId ? [roleId] : [] },
    embeds: [{
      author: { name: `🏠 New base on ${pf.name}` },
      title: post.title.slice(0, 250),
      url: post.url,
      description: `${text}\n\n**[Open on ${pf.name} →](${post.url})**`,
      color: pf.color,
      image: post.image ? { url: post.image } : undefined,
      timestamp: post.time ? new Date(post.time).toISOString() : undefined,
    }],
  };
  const r = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 429) {
    const wait = Number((await r.json().catch(() => ({}))).retry_after || 5) * 1000;
    await sleep(wait);
    return announce(platformKey, post, state);
  }
  if (!r.ok) throw new Error(`Discord ответил ${r.status}: ${await r.text()}`);
  console.log(`Анонс отправлен: [${pf.name}] ${post.title}`);
}

// ---------- основной цикл ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function check(state) {
  for (const key of Object.keys(PLATFORMS)) {
    try {
      const posts = await PLATFORMS[key].fetch();
      const firstRun = !state[key];
      const seen = new Set(state[key] || []);

      if (TEST && posts[0]) {
        await announce(key, posts[0], state);
      } else if (!firstRun) {
        // новые — от старых к новым, чтобы в канале шли по порядку
        const fresh = posts.filter(p => !seen.has(p.id)).sort((a, b) => a.time - b.time);
        for (const p of fresh) await announce(key, p, state);
      } else {
        console.log(`${PLATFORMS[key].name}: первый запуск, запомнил ${posts.length} старых постов, их не анонсирую.`);
      }

      for (const p of posts) seen.add(p.id);
      state[key] = [...seen].slice(-200);
      saveState(state);
    } catch (e) {
      console.error(`${PLATFORMS[key].name}: ${e.message}`);
    }
  }
}

(async () => {
  // Только одна копия скрипта за раз, иначе анонсы задвоятся
  try {
    const oldPid = Number(fs.readFileSync(LOCK, 'utf8'));
    const fresh = Date.now() - fs.statSync(LOCK).mtimeMs < 15 * 60 * 1000; // живая копия обновляет файл каждые 5 минут
    if (oldPid && oldPid !== process.pid && fresh) {
      process.kill(oldPid, 0); // бросит ошибку, если процесса уже нет
      console.log(`Скрипт уже работает в фоне (процесс ${oldPid}). Эту копию закрываю.`);
      if (!TEST) { await sleep(4000); process.exit(0); }
    }
  } catch { /* старой копии нет */ }
  if (!TEST) {
    try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} // на хостинге с read-only диском просто пропускаем
    process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch {} });
    process.on('SIGINT', () => process.exit(0));
  }

  if (!WEBHOOK) {
    if (process.platform !== 'win32') {
      // На хостинге буфера обмена нет — вебхук обязателен как переменная окружения.
      console.error('DISCORD_WEBHOOK_URL не задан. Добавь переменную окружения DISCORD_WEBHOOK_URL в настройках хостинга и перезапусти.');
      process.exit(1);
    }
    // Нет ссылки в .env — ждём, пока в буфере обмена появится ссылка вебхука
    // (в Discord: настройки канала announcement → Интеграции → Вебхуки → Копировать URL вебхука)
    console.log('Жду ссылку вебхука: нажми в Discord «Копировать URL вебхука», я сам её подхвачу...');
    while (!(WEBHOOK = readWebhookFromClipboard())) await sleep(2000);
    saveWebhookToEnv(WEBHOOK);
    console.log('Ссылку вебхука взял из буфера обмена и сохранил в .env.');
  }
  const state = loadState();
  console.log(`Слежу за Boosty (${BOOSTY_BLOG}) и Patreon (${PATREON_URL}), проверка раз в 5 минут.`);
  await check(state);
  if (TEST) { console.log('Тест завершён.'); return; }
  setInterval(() => {
    try { fs.writeFileSync(LOCK, String(process.pid)); } catch {}
    check(state);
  }, CHECK_EVERY_MS);
})();

// ---------- мелочи ----------
function readWebhookFromClipboard() {
  if (process.platform !== 'win32') return null;
  try {
    const text = require('child_process')
      .execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf8', timeout: 10000 })
      .trim();
    return WEBHOOK_RE.test(text) ? text : null;
  } catch { return null; }
}
function saveWebhookToEnv(url) {
  let lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  if (!lines.length && fs.existsSync(path.join(__dirname, '.env.example'))) {
    lines = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8').split(/\r?\n/);
  }
  let done = false;
  lines = lines.map(l => /^\s*DISCORD_WEBHOOK_URL\s*=/.test(l) ? (done = true, `DISCORD_WEBHOOK_URL=${url}`) : l);
  if (!done) lines.push(`DISCORD_WEBHOOK_URL=${url}`);
  fs.writeFileSync(ENV_FILE, lines.join('\r\n'));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
