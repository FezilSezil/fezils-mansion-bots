// Бот отзывов для Fezil's Mansion.
// Когда в тикете (канал ticket-XXXX) появляется вложение от живого человека — это сдача заказа
// (стафф прикрепил готовую базу) — бот кидает туда кнопку «Leave a review». Не при открытии тикета
// (заказ ещё не готов) и не при закрытии (клиенту уже всё равно) — а прямо в момент сдачи работы.
// Человек жмёт кнопку → всплывает окно (оценка 1–5 + текст) → отзыв уходит в канал REVIEWS.
// Заодно ставит медленный режим 2 секунды в текстовых чатах.
//
// Запуск: через start_announcer.bat (он же ставит discord.js при первом запуске).
// Токен бота: при первом запуске скрипт ждёт, пока ты скопируешь токен в Developer Portal,
// сам забирает его из буфера обмена и сохраняет в .env.

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '.env');
loadEnv(ENV_FILE);

const TICKET_RE = /^ticket-/i;                          // так Ticket Tool называет каналы тикетов
const REVIEWS_CHANNEL_ID = (process.env.REVIEWS_CHANNEL_ID || '1427005833836757223').trim(); // канал REVIEWS, по ID — надёжнее чем по имени (эмодзи/спецсимволы в названии ломают поиск по regex)
const REVIEWS_CHANNEL_MATCH = /reviews/i;               // запасной вариант, если ID не найден
const SLOWMODE_SECONDS = 2;
const SLOWMODE_CHANNEL_MATCH = [/global-ru/i, /global-eu/i, /building/i];
const DONE_FILE = path.join(__dirname, 'reviews_done.json');
const LOCK = path.join(__dirname, 'review_bot.lock');
const TOKEN_RE = /^[\w-]{24,}\.[\w-]{6,}\.[\w-]{27,}$/;
const postedButtonChannels = new Set(); // чтобы не кидать кнопку в один тикет дважды за время работы бота
const archivedChannels = new Set();     // чтобы не архивировать один тикет дважды
const DELIVERY_LINK_RE = /(drive\.google\.com|youtu\.be|youtube\.com|disk\.yandex|drive\.yandex)/i; // ссылка на видео или гугл/яндекс диск = сдача заказа
const CLOSE_TEXT_RE = /\bclos(ed|ing)\b|закры/i;        // Ticket Tool пишет это при закрытии — момент для архивации
const STATS_FILE = path.join(__dirname, 'review_stats.json');
const LOG_CHANNEL_NAME = 'ticket-logs';
let lastStatsRename = 0;
let statsRenameTimer = null;

async function maybePostReviewButton(channel) {
  if (postedButtonChannels.has(channel.id)) return;
  postedButtonChannels.add(channel.id);
  await sleep(1500);
  await postReviewButton(channel).catch(e => console.error(`Тикет ${channel.name}: ${e.message}`));
}

let TOKEN = (process.env.DISCORD_TOKEN || '').trim();

let discord;
try { discord = require('discord.js'); }
catch {
  console.error('Не установлен discord.js. Запусти start_announcer.bat, он поставит его сам.');
  process.exit(1);
}
const {
  Client, GatewayIntentBits, Events, ChannelType, PermissionFlagsBits, Partials, AuditLogEvent,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, MessageFlags,
} = discord;

(async () => {
  if (!singleInstance()) return;

  if (!TOKEN) {
    if (process.platform !== 'win32') {
      // На хостинге (Railway/Fly и т.п.) буфера обмена нет — токен обязателен как переменная окружения.
      console.error('DISCORD_TOKEN не задан. Добавь переменную окружения DISCORD_TOKEN в настройках хостинга и перезапусти.');
      process.exit(1);
    }
    console.log('Жду токен бота: в Developer Portal → Bot → Reset Token → Copy. Я сам его подхвачу...');
    while (!(TOKEN = readTokenFromClipboard())) await sleep(2000);
    saveEnvValue('DISCORD_TOKEN', TOKEN);
    console.log('Токен взял из буфера обмена и сохранил в .env.');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  });

  client.once(Events.ClientReady, async () => {
    console.log(`Бот отзывов запущен как ${client.user.tag}`);
    if (client.guilds.cache.size === 0) {
      const invite = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`;
      console.log('Бот ещё не на сервере. Открываю ссылку приглашения, выбери Fezil\'s Mansion и нажми «Авторизовать».');
      console.log(invite);
      openInBrowser(invite);
    }
    for (const guild of client.guilds.cache.values()) await setupGuild(guild);
  });

  client.on(Events.GuildCreate, guild => setupGuild(guild).catch(console.error));

  // Стафф скинул ссылку на видео или Google/Яндекс Диск в тикете (сдал готовую базу) → кнопка отзыва.
  // НЕ по вложению/скриншоту — скриншот могут кинуть просто как пример базы до заказа, это не сдача.
  // Не при открытии тикета (заказ ещё не готов) и не при закрытии (клиенту уже всё равно) —
  // а прямо в момент, когда заказ реально сдают, пока человек ещё в канале и ему не пофиг.
  client.on(Events.MessageCreate, async message => {
    try {
      if (!message.guild || message.channel.type !== ChannelType.GuildText || !TICKET_RE.test(message.channel.name)) return;
      if (message.author?.bot) return; // сообщения ботов (Ticket Tool и т.п.) не считаются
      if (!DELIVERY_LINK_RE.test(message.content || '')) return; // ждём именно ссылку на видео/диск — это и есть сдача
      await maybePostReviewButton(message.channel);
    } catch (e) { console.error(e); }
  });

  // Ticket Tool написал «closed»/«закрыт» в тикете → архивируем переписку в приватный канал ticket-logs.
  client.on(Events.MessageCreate, async message => {
    try {
      if (!message.guild || message.channel.type !== ChannelType.GuildText || !TICKET_RE.test(message.channel.name)) return;
      if (!message.author?.bot) return; // это сообщение пишет сам Ticket Tool, а не человек
      if (!CLOSE_TEXT_RE.test(message.content || '')) return;
      await archiveTicket(message.channel);
    } catch (e) { console.error(e); }
  });

  client.on(Events.InteractionCreate, async i => {
    try {
      if (i.isChatInputCommand() && i.commandName === 'review-button') {
        await postReviewButton(i.channel);
        return i.reply({ content: 'Кнопка отзыва отправлена.', flags: MessageFlags.Ephemeral });
      }

      if (i.isButton() && i.customId === 'review_open') {
        if (alreadyReviewed(i.channelId, i.user.id)) {
          return i.reply({ content: 'You have already left a review for this order. Thank you! 💛', flags: MessageFlags.Ephemeral });
        }
        const modal = new ModalBuilder().setCustomId('review_submit').setTitle('Leave a review');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('rating').setLabel('Rating from 1 to 5')
              .setStyle(TextInputStyle.Short).setPlaceholder('5').setMinLength(1).setMaxLength(1).setRequired(true)),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('text').setLabel('Your review')
              .setStyle(TextInputStyle.Paragraph).setPlaceholder('How was the base? How did it hold up on wipe?')
              .setMinLength(10).setMaxLength(1000).setRequired(true)),
        );
        return i.showModal(modal);
      }

      if (i.isModalSubmit() && i.customId === 'review_submit') {
        const rating = Number(i.fields.getTextInputValue('rating').trim());
        const text = i.fields.getTextInputValue('text').trim();
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
          return i.reply({ content: 'Rating has to be a number from 1 to 5. Press the button again and try once more.', flags: MessageFlags.Ephemeral });
        }
        const reviews = i.guild.channels.cache.get(REVIEWS_CHANNEL_ID)
          || i.guild.channels.cache.find(c => c.type === ChannelType.GuildText && REVIEWS_CHANNEL_MATCH.test(c.name));
        if (!reviews) return i.reply({ content: 'Could not find the reviews channel, please tell the staff.', flags: MessageFlags.Ephemeral });

        const embed = new EmbedBuilder()
          .setColor(0xF1C40F)
          .setAuthor({ name: i.member?.displayName || i.user.username, iconURL: i.user.displayAvatarURL() })
          .setTitle('★'.repeat(rating) + '☆'.repeat(5 - rating))
          .setDescription(text)
          .setFooter({ text: 'Custom base order' })
          .setTimestamp();
        await reviews.send({ content: `Review from <@${i.user.id}>`, embeds: [embed], allowedMentions: { users: [] } });
        markReviewed(i.channelId, i.user.id);
        updateStats(rating, i.guild);
        console.log(`Отзыв от ${i.user.tag}: ${rating}/5`);
        return i.reply({ content: `Thank you! Your review is now in <#${reviews.id}> 💛`, flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      console.error(e);
      if (i.isRepliable() && !i.replied) i.reply({ content: 'Something went wrong, please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  // ---------- общие логи сервера (канал #logs) ----------
  client.on(Events.GuildMemberAdd, member => logServerEvent(member.guild, {
    color: 0x2ECC71,
    title: '📥 Участник зашёл',
    description: `${member.user.tag} (<@${member.user.id}>)`,
    footer: `ID: ${member.user.id}`,
  }).catch(console.error));

  client.on(Events.GuildMemberRemove, member => logServerEvent(member.guild, {
    color: 0xE67E22,
    title: '📤 Участник вышел',
    description: `${member.user.tag} (<@${member.user.id}>)`,
    footer: `ID: ${member.user.id}`,
  }).catch(console.error));

  client.on(Events.GuildBanAdd, async ban => {
    const executor = await findAuditExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id).catch(() => null);
    await logServerEvent(ban.guild, {
      color: 0xE74C3C,
      title: '🔨 Бан',
      description: `${ban.user.tag} (<@${ban.user.id}>)${executor ? `\nКто забанил: ${executor.tag}` : ''}`,
      footer: `ID: ${ban.user.id}`,
    }).catch(console.error);
  });

  client.on(Events.GuildBanRemove, ban => logServerEvent(ban.guild, {
    color: 0x3498DB,
    title: '🔓 Разбан',
    description: `${ban.user.tag} (<@${ban.user.id}>)`,
    footer: `ID: ${ban.user.id}`,
  }).catch(console.error));

  client.on(Events.MessageDelete, message => {
    if (!message.guild || message.author?.bot) return;
    logServerEvent(message.guild, {
      color: 0x992D22,
      title: '🗑️ Сообщение удалено',
      description: `Канал: <#${message.channel.id}>\nАвтор: ${message.author ? message.author.tag : 'неизвестно'}\n${(message.content || '*(нет текста / вложение)*').slice(0, 1000)}`,
    }).catch(console.error);
  });

  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    if (!newMessage.guild || newMessage.author?.bot) return;
    if (oldMessage.content === newMessage.content) return; // например, только добавился embed от ссылки
    logServerEvent(newMessage.guild, {
      color: 0xF39C12,
      title: '✏️ Сообщение изменено',
      description: `Канал: <#${newMessage.channel.id}>\nАвтор: ${newMessage.author.tag}\n**Было:** ${(oldMessage.content || '*(пусто)*').slice(0, 500)}\n**Стало:** ${(newMessage.content || '*(пусто)*').slice(0, 500)}`,
    }).catch(console.error);
  });

  client.on(Events.ChannelCreate, channel => {
    if (!channel.guild) return;
    logServerEvent(channel.guild, {
      color: 0x2ECC71,
      title: '📁 Канал создан',
      description: `${channel.name} (${channel.type === ChannelType.GuildVoice ? 'голосовой' : 'текстовый'})`,
    }).catch(console.error);
  });

  client.on(Events.ChannelDelete, channel => {
    if (!channel.guild) return;
    logServerEvent(channel.guild, {
      color: 0xE74C3C,
      title: '🗑️ Канал удалён',
      description: `${channel.name}`,
    }).catch(console.error);
  });

  client.on(Events.GuildRoleCreate, role => logServerEvent(role.guild, {
    color: 0x2ECC71,
    title: '🎭 Роль создана',
    description: `${role.name}`,
  }).catch(console.error));

  client.on(Events.GuildRoleDelete, role => logServerEvent(role.guild, {
    color: 0xE74C3C,
    title: '🎭 Роль удалена',
    description: `${role.name}`,
  }).catch(console.error));

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;
    const added = newRoles.filter(r => !oldRoles.has(r.id));
    const removed = oldRoles.filter(r => !newRoles.has(r.id));
    if (added.size === 0 && removed.size === 0) return;
    const parts = [];
    if (added.size) parts.push(`Выданы роли: ${added.map(r => r.name).join(', ')}`);
    if (removed.size) parts.push(`Сняты роли: ${removed.map(r => r.name).join(', ')}`);
    logServerEvent(newMember.guild, {
      color: 0x3498DB,
      title: '🎭 Роли участника изменены',
      description: `${newMember.user.tag} (<@${newMember.user.id}>)\n${parts.join('\n')}`,
    }).catch(console.error);
  });

  await client.login(TOKEN).catch(e => {
    console.error(`Не смог войти: ${e.message}`);
    if (/token/i.test(e.message)) {
      console.error('Токен не подошёл. Удаляю его из .env, запусти меня снова и скопируй новый токен.');
      saveEnvValue('DISCORD_TOKEN', '');
    }
    process.exit(1);
  });
})();

async function setupGuild(guild) {
  // Команда для стаффа, чтобы вручную кинуть кнопку отзыва в любой канал
  await guild.commands.create({
    name: 'review-button',
    description: 'Post the "Leave a review" button in this channel',
    default_member_permissions: String(PermissionFlagsBits.ManageMessages),
  }).catch(e => console.error(`Команда: ${e.message}`));

  // Медленный режим 2 секунды в чатах
  await guild.channels.fetch();
  for (const ch of guild.channels.cache.values()) {
    if (ch.type !== ChannelType.GuildText) continue;
    if (!SLOWMODE_CHANNEL_MATCH.some(re => re.test(ch.name))) continue;
    if (ch.rateLimitPerUser === SLOWMODE_SECONDS) continue;
    await ch.setRateLimitPerUser(SLOWMODE_SECONDS).then(
      () => console.log(`Медленный режим ${SLOWMODE_SECONDS} с: ${ch.name}`),
      e => console.error(`Медленный режим ${ch.name}: ${e.message}`));
  }
}

async function postReviewButton(channel) {
  const embed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('⭐ Happy with your base?')
    .setDescription('Once your order is done, it would mean a lot if you left a short review.\nPress the button below, it takes less than a minute.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('review_open').setLabel('Leave a review').setEmoji('⭐').setStyle(ButtonStyle.Primary));
  await channel.send({ embeds: [embed], components: [row] });
  console.log(`Кнопка отзыва отправлена в ${channel.name}`);
}

// ---------- статистика отзывов (голосовой канал вида ⭐ 4.8 (23)) ----------
function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { return { count: 0, sum: 0 }; }
}
function saveStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
}
function updateStats(rating, guild) {
  const stats = loadStats();
  stats.count += 1;
  stats.sum += rating;
  saveStats(stats);
  updateStatsChannel(guild, stats).catch(e => console.error(`Статистика отзывов: ${e.message}`));
}
// Discord позволяет переименовывать канал примерно 2 раза за 10 минут — поэтому не переименовываем
// сразу на каждый отзыв, а копим и применяем самое свежее значение не чаще раза в 10 минут.
async function updateStatsChannel(guild, stats) {
  const name = `⭐ ${(stats.sum / stats.count).toFixed(1)} (${stats.count})`;
  const RENAME_COOLDOWN = 10 * 60 * 1000;
  const since = Date.now() - lastStatsRename;
  if (since < RENAME_COOLDOWN) {
    clearTimeout(statsRenameTimer);
    statsRenameTimer = setTimeout(() => {
      const fresh = loadStats();
      applyStatsChannelName(guild, `⭐ ${(fresh.sum / fresh.count).toFixed(1)} (${fresh.count})`).catch(e => console.error(`Статистика отзывов: ${e.message}`));
    }, RENAME_COOLDOWN - since);
    return;
  }
  await applyStatsChannelName(guild, name);
}
async function applyStatsChannelName(guild, name) {
  await guild.channels.fetch();
  let ch = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && /^⭐/.test(c.name));
  if (!ch) {
    ch = await guild.channels.create({ name, type: ChannelType.GuildVoice, permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.Connect] },
    ] });
  } else if (ch.name !== name) {
    await ch.setName(name);
  } else {
    return;
  }
  lastStatsRename = Date.now();
  console.log(`Канал со статистикой отзывов: ${name}`);
}

// ---------- общие логи сервера (канал #logs) ----------
const SERVER_LOG_CHANNEL_NAME = 'logs';
async function getOrCreateServerLogChannel(guild) {
  await guild.channels.fetch();
  let ch = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === SERVER_LOG_CHANNEL_NAME);
  if (!ch) {
    ch = await guild.channels.create({
      name: SERVER_LOG_CHANNEL_NAME,
      type: ChannelType.GuildText,
      permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] }],
    });
    console.log(`Создан канал общих логов сервера: ${ch.name}`);
  }
  return ch;
}
async function logServerEvent(guild, { color, title, description, footer }) {
  if (!guild) return;
  const ch = await getOrCreateServerLogChannel(guild);
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description?.slice(0, 4000) || '—')
    .setTimestamp();
  if (footer) embed.setFooter({ text: footer });
  await ch.send({ embeds: [embed] });
}
// Смотрим аудит-лог, чтобы понять, кто выполнил действие (например, кто забанил) — не всегда доступно/точно.
async function findAuditExecutor(guild, auditEventType, targetId) {
  const logs = await guild.fetchAuditLogs({ type: auditEventType, limit: 5 });
  const entry = logs.entries.find(e => e.target?.id === targetId);
  return entry?.executor || null;
}

// ---------- архивация закрытых тикетов ----------
async function getOrCreateLogChannel(guild) {
  await guild.channels.fetch();
  let ch = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === LOG_CHANNEL_NAME);
  if (!ch) {
    ch = await guild.channels.create({
      name: LOG_CHANNEL_NAME,
      type: ChannelType.GuildText,
      permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] }],
    });
    console.log(`Создан канал для логов тикетов: ${ch.name}`);
  }
  return ch;
}
async function fetchAllMessages(channel, limit = 500) {
  const out = [];
  let before;
  while (out.length < limit) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    out.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return out.reverse();
}
async function archiveTicket(channel) {
  if (archivedChannels.has(channel.id)) return;
  archivedChannels.add(channel.id);
  try {
    await sleep(2000); // даём Ticket Tool дописать сообщение о закрытии перед выгрузкой истории
    const messages = await fetchAllMessages(channel);
    const lines = messages.map(m => {
      const time = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
      const text = m.content || '';
      const atts = m.attachments?.size ? ' ' + [...m.attachments.values()].map(a => a.url).join(' ') : '';
      return `[${time}] ${m.author.tag}: ${text}${atts}`;
    });
    const transcript = lines.join('\n') || '(пусто)';
    const logChannel = await getOrCreateLogChannel(channel.guild);
    const buffer = Buffer.from(transcript, 'utf8');
    await logChannel.send({
      content: `Транскрипт тикета **${channel.name}**`,
      files: [{ attachment: buffer, name: `${channel.name}.txt` }],
    });
    console.log(`Тикет ${channel.name} заархивирован в ${logChannel.name}`);
  } catch (e) { console.error(`Архивация ${channel.name}: ${e.message}`); }
}

// ---------- мелочи ----------
function alreadyReviewed(channelId, userId) {
  try { return JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')).includes(`${channelId}:${userId}`); } catch { return false; }
}
function markReviewed(channelId, userId) {
  let done = [];
  try { done = JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')); } catch {}
  done.push(`${channelId}:${userId}`);
  fs.writeFileSync(DONE_FILE, JSON.stringify(done.slice(-5000)));
}
function singleInstance() {
  try {
    const oldPid = Number(fs.readFileSync(LOCK, 'utf8'));
    const fresh = Date.now() - fs.statSync(LOCK).mtimeMs < 15 * 60 * 1000;
    if (oldPid && oldPid !== process.pid && fresh) {
      process.kill(oldPid, 0);
      console.log(`Бот отзывов уже работает (процесс ${oldPid}). Эту копию закрываю.`);
      setTimeout(() => process.exit(0), 4000);
      return false;
    }
  } catch {}
  try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} // на хостинге с read-only диском просто пропускаем — не критично
  setInterval(() => { try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} }, 5 * 60 * 1000);
  process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch {} });
  process.on('SIGINT', () => process.exit(0));
  return true;
}
function readTokenFromClipboard() {
  if (process.platform !== 'win32') return null;
  try {
    const text = require('child_process')
      .execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf8', timeout: 10000 }).trim();
    return TOKEN_RE.test(text) ? text : null;
  } catch { return null; }
}
function openInBrowser(url) {
  if (process.platform !== 'win32') return;
  try { require('child_process').exec(`start "" "${url}"`); } catch {}
}
function saveEnvValue(key, value) {
  let lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  let done = false;
  lines = lines.map(l => new RegExp(`^\\s*${key}\\s*=`).test(l) ? (done = true, `${key}=${value}`) : l);
  if (!done) lines.push(`${key}=${value}`);
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
