require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Pool }    = require('pg');
const http        = require('http');

// ═══════════════════════════════════════════════════════════════
//  ENVIRONMENT VARIABLES  (set all of these in Render)
// ═══════════════════════════════════════════════════════════════
const TOKEN      = process.env.BOT_TOKEN      || '8942060276:AAFFklX6Hd4gILLBhtrIykOVJmFQBFSlER4';
const DB_URL     = process.env.DATABASE_URL   || 'postgresql://optxbot_db_user:Wm2lu8R0lk0YGLTLDa0wVfO7kFi6mbjA@dpg-d8cg1f6gvqtc7385d0mg-a.oregon-postgres.render.com/optxbot_db';
const BOT_USER   = process.env.BOT_USERNAME   || 'AutoGiftersRobot';
const BOT_NAME   = process.env.BOT_NAME       || 'Auto Gifters Bot';
const PORT       = process.env.PORT           || 3000;
const ADMIN1     = parseInt(process.env.ADMIN_ID_1 || '0', 10);
const ADMIN2     = parseInt(process.env.ADMIN_ID_2 || '0', 10);
const NEED_REFS  = parseInt(process.env.REQUIRED_REFS || '15', 10);

// Static stats (screenshot values)
const STATIC_USERS    = 30234;
const STATIC_WITHDRAW = 329;

// Must-join channels
const CHANNELS = [
  { id: parseInt(process.env.CH1_ID || '-1002813886587'), url: process.env.CH1_URL || 'https://t.me/TASKWORKAGENT'  },
  { id: parseInt(process.env.CH2_ID || '-1002843266431'), url: process.env.CH2_URL || 'https://t.me/clickdeveloper' },
  { id: parseInt(process.env.CH3_ID || '-1003851686498'), url: process.env.CH3_URL || 'https://t.me/otp_X_official' },
];
const PROOF_URL = process.env.PROOF_URL || 'https://t.me/PayoutzPremium';

// ═══════════════════════════════════════════════════════════════
//  HTTP SERVER  (Render requires open port)
// ═══════════════════════════════════════════════════════════════
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`${BOT_NAME} is Running ✅`);
}).listen(PORT, () => console.log(`🌐 HTTP :${PORT}`));

// ═══════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
const run  = (sql, p = []) => pool.query(sql, p);

async function initDB() {
  await run(`
    CREATE TABLE IF NOT EXISTS agb_users (
      user_id      BIGINT      PRIMARY KEY,
      first_name   TEXT        NOT NULL DEFAULT '',
      username     TEXT,
      referred_by  BIGINT      DEFAULT NULL,
      cycle_refs   INT         NOT NULL DEFAULT 0,
      total_refs   INT         NOT NULL DEFAULT 0,
      total_orders INT         NOT NULL DEFAULT 0,
      is_banned    BOOLEAN     NOT NULL DEFAULT FALSE,
      joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agb_orders (
      id           SERIAL      PRIMARY KEY,
      user_id      BIGINT      NOT NULL,
      ordered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agb_admins (
      user_id      BIGINT      PRIMARY KEY,
      added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agb_settings (
      key          TEXT        PRIMARY KEY,
      value        TEXT        NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS agb_broadcasts (
      id           SERIAL      PRIMARY KEY,
      sent_by      BIGINT      NOT NULL,
      total_sent   INT         NOT NULL DEFAULT 0,
      total_failed INT         NOT NULL DEFAULT 0,
      sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO agb_settings(key,value) VALUES
      ('maintenance', 'false'),
      ('ref_notify',  'true'),
      ('announcement',''),
      ('welcome_msg', '')
    ON CONFLICT DO NOTHING;
  `);

  for (const aid of [ADMIN1, ADMIN2]) {
    if (aid) await run(`INSERT INTO agb_admins(user_id) VALUES($1) ON CONFLICT DO NOTHING`, [aid]);
  }
  console.log('✅ Database ready');
}

// ── DB helpers ─────────────────────────────────────────────────
async function getUser(uid) {
  const r = await run('SELECT * FROM agb_users WHERE user_id=$1', [uid]);
  return r.rows[0] || null;
}
async function isAdmin(uid) {
  const r = await run('SELECT 1 FROM agb_admins WHERE user_id=$1', [uid]);
  return r.rows.length > 0;
}
async function getSetting(k) {
  const r = await run('SELECT value FROM agb_settings WHERE key=$1', [k]);
  return r.rows[0]?.value ?? '';
}
async function setSetting(k, v) {
  await run(
    `INSERT INTO agb_settings(key,value) VALUES($1,$2)
     ON CONFLICT(key) DO UPDATE SET value=$2`, [k, v]
  );
}
async function isMaintenance() { return (await getSetting('maintenance')) === 'true'; }

async function registerUser(uid, fname, uname, refBy) {
  const ex = await getUser(uid);
  if (ex) return { user: ex, isNew: false };

  await run(
    `INSERT INTO agb_users(user_id,first_name,username,referred_by)
     VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [uid, fname || '', uname || null, refBy || null]
  );
  if (refBy && refBy !== uid) {
    await run(
      `UPDATE agb_users SET cycle_refs=cycle_refs+1, total_refs=total_refs+1 WHERE user_id=$1`,
      [refBy]
    );
  }
  const user = await getUser(uid);
  return { user, isNew: true, refBy };
}

async function getAllUserIds() {
  const r = await run('SELECT user_id FROM agb_users WHERE is_banned=FALSE');
  return r.rows.map(x => x.user_id);
}

// ═══════════════════════════════════════════════════════════════
//  BOT
// ═══════════════════════════════════════════════════════════════
const bot     = new TelegramBot(TOKEN, { polling: true });
const lastPop = new Map(); // uid → { chatId, msgId }   last popup
const lastCmd = new Map(); // uid → { chatId, msgId }   last command message
const adSt    = new Map(); // uid → { step }             admin state machine

// ── Delete tracked messages ────────────────────────────────────
async function delMsg(chatId, msgId) {
  await bot.deleteMessage(chatId, msgId).catch(() => {});
}
async function killPopup(uid) {
  if (lastPop.has(uid)) {
    const { chatId, msgId } = lastPop.get(uid);
    await delMsg(chatId, msgId);
    lastPop.delete(uid);
  }
}
async function killLastCmd(uid) {
  if (lastCmd.has(uid)) {
    const { chatId, msgId } = lastCmd.get(uid);
    await delMsg(chatId, msgId);
    lastCmd.delete(uid);
  }
}

// ── Channel membership check ────────────────────────────────────
async function checkMember(uid) {
  for (const ch of CHANNELS) {
    try {
      const m = await bot.getChatMember(ch.id, uid);
      if (!m || ['left', 'kicked'].includes(m.status)) return false;
    } catch { return false; }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════
//  KEYBOARDS
// ═══════════════════════════════════════════════════════════════

// Channel join inline
const joinKB = () => ({
  inline_keyboard: [
    [
      { text: '✈️ Join', url: CHANNELS[0].url },
      { text: '✈️ Join', url: CHANNELS[1].url },
    ],
    [
      { text: '✈️ Join', url: CHANNELS[2].url },
      { text: '📋 Proofs', url: PROOF_URL },
    ],
    [{ text: 'Continue', callback_data: 'continue' }],
  ],
});

// Main persistent bottom keyboard
const mainKB = () => ({
  keyboard: [
    [{ text: '🎀 Get Premium' }, { text: '💀 Invitation' }],
    [{ text: '🐶 Statistics' }],
  ],
  resize_keyboard:   true,
  persistent:        true,
  is_persistent:     true,
  one_time_keyboard: false,
});

// OK dismiss button
const okKB = () => ({
  inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]],
});

// Confirm/Cancel inline
const confirmKB = () => ({
  inline_keyboard: [[
    { text: '✅ Confirm', callback_data: 'confirm' },
    { text: '❌ Cancel',  callback_data: 'cancel'  },
  ]],
});

// Admin panel keyboard — 2 columns, many sections
const adminKB = (maint, refNotify) => ({
  inline_keyboard: [
    // ── Stats & Reports ──
    [
      { text: '📊 Live Stats',         callback_data: 'ad_stats'      },
      { text: '📈 Top Referrers',       callback_data: 'ad_top'        },
    ],
    [
      { text: '📅 Today Report',        callback_data: 'ad_today'      },
      { text: '📆 Weekly Report',       callback_data: 'ad_weekly'     },
    ],
    // ── User Management ──
    [
      { text: '👥 All Users',           callback_data: 'ad_users_0'    },
      { text: '🔍 Search User',         callback_data: 'ad_search'     },
    ],
    [
      { text: '📨 User Detail',         callback_data: 'ad_detail'     },
      { text: '🔄 Reset Cycle',         callback_data: 'ad_resetcycle' },
    ],
    [
      { text: '🚫 Ban User',            callback_data: 'ad_ban'        },
      { text: '✅ Unban User',           callback_data: 'ad_unban'      },
    ],
    [
      { text: '🚷 Banned List',         callback_data: 'ad_banned'     },
      { text: '💎 Give Premium',        callback_data: 'ad_giveprem'   },
    ],
    // ── Orders ──
    [
      { text: '📋 Recent Orders',       callback_data: 'ad_orders'     },
      { text: '🗑️ Delete Order',        callback_data: 'ad_delorder'   },
    ],
    [
      { text: '📦 Orders by User',      callback_data: 'ad_userorders' },
      { text: '📜 Broadcast History',   callback_data: 'ad_bchistory'  },
    ],
    // ── Broadcast & Announce ──
    [
      { text: '📢 Broadcast All',       callback_data: 'ad_broadcast'  },
      { text: '📣 Set Announcement',    callback_data: 'ad_announce'   },
    ],
    [
      { text: '✏️ Set Welcome Msg',     callback_data: 'ad_setwelcome' },
      { text: '🗒️ Clear Welcome',       callback_data: 'ad_clearwelcome'},
    ],
    // ── Settings ──
    [
      { text: `🔧 Maint: ${maint ? '🔴ON' : '🟢OFF'}`,     callback_data: 'ad_maint'      },
      { text: `🔔 RefNotify: ${refNotify ? '🟢ON' : '🔴OFF'}`, callback_data: 'ad_refnotify' },
    ],
    [
      { text: '⚙️ Set Req Refs',        callback_data: 'ad_setrefs'    },
      { text: '📊 DB Overview',         callback_data: 'ad_dboverview' },
    ],
    // ── Admin Management ──
    [
      { text: '👮 Admin List',          callback_data: 'ad_adminlist'  },
      { text: '➕ Add Admin',            callback_data: 'ad_addadmin'   },
    ],
    [
      { text: '➖ Remove Admin',         callback_data: 'ad_rmadmin'    },
      { text: '🔁 Refresh Panel',       callback_data: 'ad_refresh'    },
    ],
  ],
});

// ═══════════════════════════════════════════════════════════════
//  SCREEN SENDERS
// ═══════════════════════════════════════════════════════════════
async function showJoin(cid) {
  return bot.sendMessage(cid, '*Must Join All Channel To Get Premium*', {
    parse_mode: 'Markdown',
    reply_markup: joinKB(),
  });
}

async function showMain(cid) {
  const ann  = await getSetting('announcement');
  const wMsg = await getSetting('welcome_msg');
  let txt = wMsg ||
    'Hey Folks 🎉, You Can Use This Bot To Get Free Telegram Premium.\n\nJust invite your 15 friends and you can get telegram premium';
  if (ann) txt += `\n\n📣 ${ann}`;
  return bot.sendMessage(cid, txt, { reply_markup: mainKB() });
}

async function showAdmin(cid, editId = null) {
  const maint     = await isMaintenance();
  const refNotify = (await getSetting('ref_notify')) === 'true';
  const reqRefs   = await getSetting('req_refs') || String(NEED_REFS);
  const ann       = await getSetting('announcement') || 'None';

  const [u, o, b, adm] = await Promise.all([
    run('SELECT COUNT(*) FROM agb_users'),
    run('SELECT COUNT(*) FROM agb_orders'),
    run('SELECT COUNT(*) FROM agb_users WHERE is_banned=TRUE'),
    run('SELECT COUNT(*) FROM agb_admins'),
  ]);

  const txt =
    `🛠️ *${BOT_NAME} — Admin Panel*\n\n` +
    `━━━━━━ 📊 Overview ━━━━━━\n` +
    `👤 Total Users: *${u.rows[0].count}*\n` +
    `📦 Total Orders: *${o.rows[0].count}*\n` +
    `🚫 Banned: *${b.rows[0].count}*\n` +
    `👮 Admins: *${adm.rows[0].count}*\n\n` +
    `━━━━━━ ⚙️ Settings ━━━━━━\n` +
    `🎯 Required Refs: *${reqRefs}*\n` +
    `🔧 Maintenance: *${maint ? '🔴 ON' : '🟢 OFF'}*\n` +
    `🔔 Ref Notify: *${refNotify ? '🟢 ON' : '🔴 OFF'}*\n` +
    `📣 Announcement: _${ann.slice(0, 30)}${ann.length > 30 ? '...' : ''}_\n\n` +
    `_${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST_`;

  const opts = { parse_mode: 'Markdown', reply_markup: adminKB(maint, refNotify) };
  if (editId) {
    return bot.editMessageText(txt, { chat_id: cid, message_id: editId, ...opts })
              .catch(() => bot.sendMessage(cid, txt, opts));
  }
  return bot.sendMessage(cid, txt, opts);
}

// ═══════════════════════════════════════════════════════════════
//  REFERRAL NOTIFICATION → sent to referrer when new user joins
// ═══════════════════════════════════════════════════════════════
async function notifyReferrer(refBy, newUserName) {
  try {
    if ((await getSetting('ref_notify')) !== 'true') return;
    const referer = await getUser(refBy);
    if (!referer || referer.is_banned) return;

    const reqRefs = parseInt(await getSetting('req_refs') || String(NEED_REFS), 10);
    const count   = referer.cycle_refs;
    const left    = reqRefs - count;
    const reached = count >= reqRefs;

    const txt =
      `🎉 *New Referral!*\n\n` +
      `👤 *${newUserName}* joined via your link!\n\n` +
      `✈️ Your Progress: *${count}/${reqRefs} Users*\n\n` +
      (reached
        ? `🎀 *Congratulations!*\nYou can now claim your *Telegram Premium!*\n\nTap *🎀 Get Premium* to claim now!`
        : `⏳ You need *${left}* more user${left > 1 ? 's' : ''} to claim Premium!`);

    await bot.sendMessage(refBy, txt, { parse_mode: 'Markdown', reply_markup: mainKB() });
  } catch (e) {
    console.error('notifyReferrer:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  /start
// ═══════════════════════════════════════════════════════════════
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const uid   = msg.from.id;
  const fname = msg.from.first_name || 'User';
  const uname = msg.from.username   || null;
  const cid   = msg.chat.id;
  const param = match[1]?.trim();
  const refBy = param && /^\d+$/.test(param) ? parseInt(param, 10) : null;

  try {
    await killPopup(uid);
    await killLastCmd(uid);

    const { user, isNew, refBy: actualRef } = await registerUser(uid, fname, uname, refBy);

    // Notify referrer about new join
    if (isNew && actualRef) {
      await notifyReferrer(actualRef, fname);
    }

    if (user?.is_banned)
      return bot.sendMessage(cid, '🚫 You are banned from this bot.');
    if (await isMaintenance() && !(await isAdmin(uid)))
      return bot.sendMessage(cid, '🔧 Bot is under maintenance. Please try again later.');

    (await checkMember(uid)) ? await showMain(cid) : await showJoin(cid);
  } catch (e) { console.error('/start:', e.message); }
});

// ═══════════════════════════════════════════════════════════════
//  SLASH COMMANDS  (all shown inline in message, not keyboard)
// ═══════════════════════════════════════════════════════════════
bot.onText(/\/admin/, async (msg) => {
  if (!(await isAdmin(msg.from.id)))
    return bot.sendMessage(msg.chat.id, '🚫 Access denied.');
  await killLastCmd(msg.from.id);
  const sent = await showAdmin(msg.chat.id);
  if (sent) lastCmd.set(msg.from.id, { chatId: msg.chat.id, msgId: sent.message_id });
});

bot.onText(/\/cancel/, async (msg) => {
  adSt.delete(msg.from.id);
  await killPopup(msg.from.id);
  const sent = await bot.sendMessage(msg.chat.id, '✅ Cancelled.', { reply_markup: mainKB() });
  lastCmd.set(msg.from.id, { chatId: msg.chat.id, msgId: sent.message_id });
});

bot.onText(/\/stats/, async (msg) => {
  if (!(await isAdmin(msg.from.id))) return;
  await killLastCmd(msg.from.id);
  const [u, o] = await Promise.all([
    run('SELECT COUNT(*) FROM agb_users'),
    run('SELECT COUNT(*) FROM agb_orders'),
  ]);
  const sent = await bot.sendMessage(msg.chat.id,
    `📊 *Quick Stats*\n\n👤 Users: *${u.rows[0].count}*\n📦 Orders: *${o.rows[0].count}*`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] } }
  );
  lastCmd.set(msg.from.id, { chatId: msg.chat.id, msgId: sent.message_id });
});

bot.onText(/\/broadcast/, async (msg) => {
  if (!(await isAdmin(msg.from.id))) return;
  adSt.set(msg.from.id, { step: 'broadcast' });
  const sent = await bot.sendMessage(msg.chat.id,
    '📢 *Broadcast Mode*\n\nSend your message now. It will be sent to all users.\nType /cancel to abort.',
    { parse_mode: 'Markdown' }
  );
  lastCmd.set(msg.from.id, { chatId: msg.chat.id, msgId: sent.message_id });
});

bot.onText(/\/ban (.+)/, async (msg, match) => {
  if (!(await isAdmin(msg.from.id))) return;
  const tid = parseInt(match[1].trim(), 10);
  if (isNaN(tid)) return bot.sendMessage(msg.chat.id, '❌ Usage: /ban USER_ID');
  await run(`UPDATE agb_users SET is_banned=TRUE WHERE user_id=$1`, [tid]);
  try { await bot.sendMessage(tid, '🚫 You have been banned from this bot.'); } catch {}
  bot.sendMessage(msg.chat.id, `🚫 User \`${tid}\` banned.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/unban (.+)/, async (msg, match) => {
  if (!(await isAdmin(msg.from.id))) return;
  const tid = parseInt(match[1].trim(), 10);
  if (isNaN(tid)) return bot.sendMessage(msg.chat.id, '❌ Usage: /unban USER_ID');
  await run(`UPDATE agb_users SET is_banned=FALSE WHERE user_id=$1`, [tid]);
  try { await bot.sendMessage(tid, '✅ You are unbanned. Type /start to continue.'); } catch {}
  bot.sendMessage(msg.chat.id, `✅ User \`${tid}\` unbanned.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/user (.+)/, async (msg, match) => {
  if (!(await isAdmin(msg.from.id))) return;
  const arg = match[1].trim();
  let r;
  if (/^\d+$/.test(arg)) r = await run(`SELECT * FROM agb_users WHERE user_id=$1`, [parseInt(arg, 10)]);
  else r = await run(`SELECT * FROM agb_users WHERE username ILIKE $1`, [arg.replace('@', '')]);
  if (!r.rows.length) return bot.sendMessage(msg.chat.id, '❌ User not found.');
  const u = r.rows[0];
  const n = u.username ? `@${u.username}` : u.first_name;
  bot.sendMessage(msg.chat.id,
    `📨 *User Detail*\n\n👤 *${n}*\n🆔 \`${u.user_id}\`\n🔗 Cycle: *${u.cycle_refs}* | Total: *${u.total_refs}*\n📦 Orders: *${u.total_orders}*\n🚫 Banned: *${u.is_banned ? 'Yes' : 'No'}*`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] } }
  );
});

bot.onText(/\/maint/, async (msg) => {
  if (!(await isAdmin(msg.from.id))) return;
  const cur = await isMaintenance();
  await setSetting('maintenance', cur ? 'false' : 'true');
  bot.sendMessage(msg.chat.id, `🔧 Maintenance ${!cur ? '🔴 ENABLED' : '🟢 DISABLED'}`);
});

// ═══════════════════════════════════════════════════════════════
//  CALLBACK QUERIES
// ═══════════════════════════════════════════════════════════════
bot.on('callback_query', async (cq) => {
  const uid  = cq.from.id;
  const cid  = cq.message.chat.id;
  const mid  = cq.message.message_id;
  const data = cq.data;

  const ack  = (t, al = false) => bot.answerCallbackQuery(cq.id, t ? { text: t, show_alert: al } : {}).catch(() => {});
  const del  = ()               => bot.deleteMessage(cid, mid).catch(() => {});
  const edit = (t, kb)          => bot.editMessageText(t, { chat_id: cid, message_id: mid, parse_mode: 'Markdown', reply_markup: kb }).catch(() => {});

  try {
    // ── User: dismiss popup ──────────────────────────────────
    if (data === 'ok') {
      await ack();
      await del();
      lastPop.delete(uid);
      return;
    }

    // ── User: channel continue ───────────────────────────────
    if (data === 'continue') {
      if (!(await checkMember(uid)))
        return ack('⚠️ Please join all channels first, then tap Continue!', true);
      await ack();
      await del();
      await showMain(cid);
      return;
    }

    // ── User: confirm order ──────────────────────────────────
    if (data === 'confirm') {
      const user   = await getUser(uid);
      const reqRef = parseInt(await getSetting('req_refs') || String(NEED_REFS), 10);
      if (!user || user.cycle_refs < reqRef)
        return ack(`⚠️ You Need To Invite ${reqRef} User To Get Premium`, true);

      await run(`INSERT INTO agb_orders(user_id) VALUES($1)`, [uid]);
      await run(`UPDATE agb_users SET total_orders=total_orders+1, cycle_refs=0 WHERE user_id=$1`, [uid]);
      await ack();
      await edit(
        '✅ *Order Confirmed!*\n\n🎉 Your Telegram Premium has been placed successfully!\n\nYou will receive it shortly.\n\nInvite *15 more friends* to claim again!',
        { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] }
      );
      lastPop.set(uid, { chatId: cid, msgId: mid });
      return;
    }

    // ── User: cancel order ───────────────────────────────────
    if (data === 'cancel') {
      await ack();
      await del();
      lastPop.delete(uid);
      return;
    }

    // ════════════════════════════════════════════════════════
    //  ADMIN CALLBACKS
    // ════════════════════════════════════════════════════════
    if (data.startsWith('ad_')) {
      if (!(await isAdmin(uid))) return ack('🚫 Access denied.', true);

      // ── Refresh panel ──
      if (data === 'ad_refresh') {
        await ack('🔄 Refreshed');
        return showAdmin(cid, mid);
      }

      // ── Maintenance toggle ──
      if (data === 'ad_maint') {
        const cur = await isMaintenance();
        await setSetting('maintenance', cur ? 'false' : 'true');
        await ack(`Maintenance ${!cur ? '🔴 ON' : '🟢 OFF'}`, true);
        return showAdmin(cid, mid);
      }

      // ── Ref notify toggle ──
      if (data === 'ad_refnotify') {
        const cur = await getSetting('ref_notify');
        await setSetting('ref_notify', cur === 'true' ? 'false' : 'true');
        await ack(`Ref Notifications ${cur === 'true' ? '🔴 OFF' : '🟢 ON'}`, true);
        return showAdmin(cid, mid);
      }

      // ── Clear welcome ──
      if (data === 'ad_clearwelcome') {
        await setSetting('welcome_msg', '');
        await ack('✅ Welcome message cleared', true);
        return showAdmin(cid, mid);
      }

      // ── Live stats ──
      if (data === 'ad_stats') {
        const today = new Date().toISOString().slice(0, 10);
        const [u, o, tu, to_, b, top5] = await Promise.all([
          run('SELECT COUNT(*) FROM agb_users'),
          run('SELECT COUNT(*) FROM agb_orders'),
          run(`SELECT COUNT(*) FROM agb_users  WHERE joined_at::date=$1::date`,  [today]),
          run(`SELECT COUNT(*) FROM agb_orders WHERE ordered_at::date=$1::date`, [today]),
          run('SELECT COUNT(*) FROM agb_users WHERE is_banned=TRUE'),
          run(`SELECT first_name,username,total_refs FROM agb_users ORDER BY total_refs DESC LIMIT 5`),
        ]);
        let txt =
          `📊 *Live Statistics*\n\n` +
          `👤 Total Users: *${u.rows[0].count}*\n` +
          `📦 Total Orders: *${o.rows[0].count}*\n` +
          `🚫 Banned: *${b.rows[0].count}*\n\n` +
          `📅 Today Users: *${tu.rows[0].count}*\n` +
          `📅 Today Orders: *${to_.rows[0].count}*\n\n` +
          `📈 *Top Referrers:*\n`;
        top5.rows.forEach((u, i) => {
          const n = u.username ? `@${u.username}` : u.first_name;
          txt += `${i + 1}. ${n} — ${u.total_refs} refs\n`;
        });
        await ack();
        return bot.sendMessage(cid, txt, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] },
        });
      }

      // ── Top referrers ──
      if (data === 'ad_top') {
        const r = await run(
          `SELECT first_name,username,total_refs,cycle_refs,total_orders
           FROM agb_users ORDER BY total_refs DESC LIMIT 15`
        );
        let txt = `📈 *Top 15 Referrers*\n\n`;
        r.rows.forEach((u, i) => {
          const n = u.username ? `@${u.username}` : u.first_name;
          txt += `${i + 1}. ${n}\n   🔗 All: *${u.total_refs}* | Cycle: *${u.cycle_refs}* | 📦 *${u.total_orders}*\n`;
        });
        await ack();
        return bot.sendMessage(cid, txt, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] },
        });
      }

      // ── Today report ──
      if (data === 'ad_today') {
        const today = new Date().toISOString().slice(0, 10);
        const [nu, no, recent] = await Promise.all([
          run(`SELECT COUNT(*) FROM agb_users  WHERE joined_at::date=$1::date`,  [today]),
          run(`SELECT COUNT(*) FROM agb_orders WHERE ordered_at::date=$1::date`, [today]),
          run(`SELECT first_name,username,joined_at FROM agb_users WHERE joined_at::date=$1::date ORDER BY joined_at DESC LIMIT 8`, [today]),
        ]);
        let txt =
          `📅 *Today's Report (${today})*\n\n` +
          `👤 New Users: *${nu.rows[0].count}*\n` +
          `📦 New Orders: *${no.rows[0].count}*\n\n` +
          `*Recent Joins:*\n`;
        recent.rows.forEach((u, i) => {
          const n = u.username ? `@${u.username}` : u.first_name;
          const t = new Date(u.joined_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
          txt += `${i + 1}. ${n} — ${t}\n`;
        });
        await ack();
        return bot.sendMessage(cid, txt, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] },
        });
      }

      // ── Weekly report ──
      if (data === 'ad_weekly') {
        const [ru, ro] = await Promise.all([
          run(`SELECT DATE(joined_at)  AS d, COUNT(*) AS c FROM agb_users  WHERE joined_at>=NOW()-INTERVAL '7 days'  GROUP BY d ORDER BY d`),
          run(`SELECT DATE(ordered_at) AS d, COUNT(*) AS c FROM agb_orders WHERE ordered_at>=NOW()-INTERVAL '7 days' GROUP BY d ORDER BY d`),
        ]);
        const uMap = {}, oMap = {};
        ru.rows.forEach(x => uMap[x.d.toISOString().slice(0, 10)] = x.c);
        ro.rows.forEach(x => oMap[x.d.toISOString().slice(0, 10)] = x.c);
        let txt = `📆 *Weekly Report (Last 7 Days)*\n\n`;
        for (let i = 6; i >= 0; i--) {
          const d = new Date(); d.setDate(d.getDate() - i);
          const dk = d.toISOString().slice(0, 10);
          txt += `📅 ${dk}: 👤 *${uMap[dk] || 0}* | 📦 *${oMap[dk] || 0}*\n`;
        }
        await ack();
        return bot.sendMessage(cid, txt, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] },
        });
      }

      // ── DB overview ──
      if (data === 'ad_dboverview') {
        const [u, o, b, adm, bc] = await Promise.all([
          run('SELECT COUNT(*) FROM agb_users'),
          run('SELECT COUNT(*) FROM agb_orders'),
          run('SELECT COUNT(*) FROM agb_users WHERE is_banned=TRUE'),
          run('SELECT COUNT(*) FROM agb_admins'),
          run('SELECT COUNT(*) FROM agb_broadcasts'),
        ]);
        const oldest = await run(`SELECT joined_at FROM agb_users ORDER BY joined_at ASC LIMIT 1`);
        await ack();
        return bot.sendMessage(cid,
          `📊 *Database Overview*\n\n` +
          `👤 Users: *${u.rows[0].count}*\n` +
          `📦 Orders: *${o.rows[0].count}*\n` +
          `🚫 Banned: *${b.rows[0].count}*\n` +
          `👮 Admins: *${adm.rows[0].count}*\n` +
          `📢 Broadcasts: *${bc.rows[0].count}*\n` +
          `📅 First User: ${oldest.rows[0] ? new Date(oldest.rows[0].joined_at).toLocaleDateString('en-IN') : 'N/A'}`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] } }
        );
      }

      // ── All users paginated ──
      if (data.startsWith('ad_users_')) {
        const page = parseInt(data.split('_')[2]) || 0;
        const PER  = 12;
        const r = await run(
          `SELECT user_id,first_name,username,cycle_refs,total_refs,total_orders,is_banned
           FROM agb_users ORDER BY joined_at DESC LIMIT $1 OFFSET $2`,
          [PER + 1, page * PER]
        );
        const hasNext = r.rows.length > PER;
        const rows    = r.rows.slice(0, PER);
        let txt = `👥 *All Users — Page ${page + 1}*\n\n`;
        rows.forEach((u, i) => {
          const n = u.username ? `@${u.username}` : u.first_name;
          txt += `${page * PER + i + 1}. ${n} [\`${u.user_id}\`]${u.is_banned ? ' 🚫' : ''}\n`;
          txt += `   🔗 ${u.cycle_refs}/${u.total_refs} | 📦 ${u.total_orders}\n`;
        });
        const nav = [];
        if (page > 0)  nav.push({ text: '⬅️ Prev', callback_data: `ad_users_${page - 1}` });
        if (hasNext)   nav.push({ text: '➡️ Next', callback_data: `ad_users_${page + 1}` });
        const kb = { inline_keyboard: [nav.length ? nav : [], [{ text: '✖️ Close', callback_data: 'ok' }]] };
        await ack();
        if (data === 'ad_users_0') return bot.sendMessage(cid, txt, { parse_mode: 'Markdown', reply_markup: kb });
        return bot.editMessageText(txt, { chat_id: cid, message_id: mid, parse_mode: 'Markdown', reply_markup: kb });
      }

      // ── Recent orders ──
      if (data === 'ad_orders') {
        const r = await run(
          `SELECT o.id,u.first_name,u.username,o.user_id,o.ordered_at
           FROM agb_orders o JOIN agb_users u ON o.user_id=u.user_id
           ORDER BY o.ordered_at DESC LIMIT 20`
        );
        let txt = `📋 *Recent 20 Orders*\n\n`;
        if (!r.rows.length) txt += 'No orders yet.';
        r.rows.forEach((o, i) => {
          const n = o.username ? `@${o.username}` : o.first_name;
          txt += `${i + 1}. #${o.id} — ${n}\n   📅 ${new Date(o.ordered_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n`;
        });
        await ack();
        return bot.sendMessage(cid, txt, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] },
        });
      }

      // ── Admin list ──
      if (data === 'ad_adminlist') {
        const r = await run(
          `SELECT a.user_id, u.first_name, u.username FROM agb_admins a
           LEFT JOIN agb_users u ON a.user_id=u.user_id`
        );
        let txt = `👮 *Admin List (${r.rows.length})*\n\n`;
        r.rows.forEach((a, i) => {
          const n = a.username ? `@${a.username}` : (a.first_name || 'Unknown');
          const isRoot = a.user_id === ADMIN1 || a.user_id === ADMIN2;
          txt += `${i + 1}. ${n} [\`${a.user_id}\`]${isRoot ? ' 👑' : ''}\n`;
        });
        await ack();
        return bot.sendMessage(cid, txt, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] },
        });
      }

      // ── Banned list ──
      if (data === 'ad_banned') {
        const r = await run(`SELECT user_id,first_name,username FROM agb_users WHERE is_banned=TRUE LIMIT 30`);
        let txt = `🚷 *Banned Users (${r.rows.length})*\n\n`;
        if (!r.rows.length) txt += 'No banned users.';
        r.rows.forEach((u, i) => {
          const n = u.username ? `@${u.username}` : u.first_name;
          txt += `${i + 1}. ${n} [\`${u.user_id}\`]\n`;
        });
        await ack();
        return bot.sendMessage(cid, txt, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] },
        });
      }

      // ── Broadcast history ──
      if (data === 'ad_bchistory') {
        const r = await run(`SELECT * FROM agb_broadcasts ORDER BY sent_at DESC LIMIT 10`);
        let txt = `📜 *Broadcast History (Last 10)*\n\n`;
        if (!r.rows.length) txt += 'No broadcasts yet.';
        r.rows.forEach((b, i) => {
          txt += `${i + 1}. ✅ *${b.total_sent}* sent | ❌ *${b.total_failed}* failed\n`;
          txt += `   📅 ${new Date(b.sent_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n`;
        });
        await ack();
        return bot.sendMessage(cid, txt, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] },
        });
      }

      // ── State-based admin actions (prompt + await message) ──
      const prompts = {
        ad_broadcast:   { step: 'broadcast',   msg: '📢 *Broadcast*\n\nSend your message to all users.\nType /cancel to abort.' },
        ad_announce:    { step: 'announce',     msg: '📣 *Set Announcement*\n\nSend announcement text (shown in main menu).\nSend `clear` to remove it.\nType /cancel to abort.' },
        ad_setwelcome:  { step: 'setwelcome',   msg: '✏️ *Set Welcome Message*\n\nSend the new welcome message.\nType /cancel to abort.' },
        ad_ban:         { step: 'ban',          msg: '🚫 *Ban User*\n\nSend the User ID to ban.\nType /cancel to abort.' },
        ad_unban:       { step: 'unban',        msg: '✅ *Unban User*\n\nSend the User ID to unban.\nType /cancel to abort.' },
        ad_addadmin:    { step: 'addadmin',     msg: '➕ *Add Admin*\n\nSend the User ID to promote.\nType /cancel to abort.' },
        ad_rmadmin:     { step: 'rmadmin',      msg: '➖ *Remove Admin*\n\nSend the User ID to demote.\nType /cancel to abort.' },
        ad_search:      { step: 'search',       msg: '🔍 *Search User*\n\nSend User ID or @username.\nType /cancel to abort.' },
        ad_detail:      { step: 'detail',       msg: '📨 *User Detail*\n\nSend the User ID.\nType /cancel to abort.' },
        ad_resetcycle:  { step: 'resetcycle',   msg: '🔄 *Reset Cycle*\n\nSend the User ID to reset cycle refs to 0.\nType /cancel to abort.' },
        ad_delorder:    { step: 'delorder',     msg: '🗑️ *Delete Order*\n\nSend the Order ID.\nType /cancel to abort.' },
        ad_giveprem:    { step: 'giveprem',     msg: '💎 *Give Premium*\n\nSend the User ID to manually add an order.\nType /cancel to abort.' },
        ad_setrefs:     { step: 'setrefs',      msg: '⚙️ *Set Required Refs*\n\nSend the number (e.g. 10).\nType /cancel to abort.' },
        ad_userorders:  { step: 'userorders',   msg: '📦 *Orders by User*\n\nSend the User ID.\nType /cancel to abort.' },
      };

      if (prompts[data]) {
        adSt.set(uid, { step: prompts[data].step });
        await ack();
        return bot.sendMessage(cid, prompts[data].msg, { parse_mode: 'Markdown' });
      }
    }

  } catch (e) {
    console.error('CB:', e.message);
    bot.answerCallbackQuery(cq.id).catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const uid   = msg.from.id;
  const fname = msg.from.first_name || 'User';
  const cid   = msg.chat.id;
  const text  = msg.text.trim();

  try {

    // ── Admin state machine ──────────────────────────────────
    if (adSt.has(uid) && (await isAdmin(uid))) {
      const { step } = adSt.get(uid);
      adSt.delete(uid);

      if (step === 'broadcast') {
        const ids = await getAllUserIds();
        let sent = 0, fail = 0;
        const st = await bot.sendMessage(cid, `📢 Sending to *${ids.length}* users...`, { parse_mode: 'Markdown' });
        for (const id of ids) {
          try { await bot.copyMessage(id, cid, msg.message_id); sent++; }
          catch { fail++; }
          await new Promise(r => setTimeout(r, 55));
        }
        await bot.deleteMessage(cid, st.message_id).catch(() => {});
        await run(`INSERT INTO agb_broadcasts(sent_by,total_sent,total_failed) VALUES($1,$2,$3)`, [uid, sent, fail]);
        return bot.sendMessage(cid,
          `✅ *Broadcast Complete!*\n\n✅ Sent: *${sent}*\n❌ Failed: *${fail}*`,
          { parse_mode: 'Markdown' }
        );
      }

      if (step === 'announce') {
        const val = text.toLowerCase() === 'clear' ? '' : text;
        await setSetting('announcement', val);
        return bot.sendMessage(cid, val ? `✅ Announcement set:\n_${val}_` : '✅ Announcement cleared.', { parse_mode: 'Markdown' });
      }

      if (step === 'setwelcome') {
        await setSetting('welcome_msg', text);
        return bot.sendMessage(cid, `✅ Welcome message updated.`);
      }

      if (step === 'ban') {
        const tid = parseInt(text, 10);
        if (isNaN(tid)) return bot.sendMessage(cid, '❌ Invalid User ID.');
        await run(`UPDATE agb_users SET is_banned=TRUE WHERE user_id=$1`, [tid]);
        try { await bot.sendMessage(tid, '🚫 You have been banned from this bot.'); } catch {}
        return bot.sendMessage(cid, `🚫 User \`${tid}\` banned.`, { parse_mode: 'Markdown' });
      }

      if (step === 'unban') {
        const tid = parseInt(text, 10);
        if (isNaN(tid)) return bot.sendMessage(cid, '❌ Invalid User ID.');
        await run(`UPDATE agb_users SET is_banned=FALSE WHERE user_id=$1`, [tid]);
        try { await bot.sendMessage(tid, '✅ You are unbanned. Type /start to continue.'); } catch {}
        return bot.sendMessage(cid, `✅ User \`${tid}\` unbanned.`, { parse_mode: 'Markdown' });
      }

      if (step === 'addadmin') {
        const tid = parseInt(text, 10);
        if (isNaN(tid)) return bot.sendMessage(cid, '❌ Invalid User ID.');
        await run(`INSERT INTO agb_admins(user_id) VALUES($1) ON CONFLICT DO NOTHING`, [tid]);
        try { await bot.sendMessage(tid, `👮 You are now an admin of *${BOT_NAME}*!\nType /admin to open the panel.`, { parse_mode: 'Markdown' }); } catch {}
        return bot.sendMessage(cid, `✅ User \`${tid}\` promoted to admin.`, { parse_mode: 'Markdown' });
      }

      if (step === 'rmadmin') {
        const tid = parseInt(text, 10);
        if (isNaN(tid)) return bot.sendMessage(cid, '❌ Invalid User ID.');
        if (tid === ADMIN1 || tid === ADMIN2)
          return bot.sendMessage(cid, '❌ Cannot remove root admins (ADMIN_ID_1 / ADMIN_ID_2).');
        await run(`DELETE FROM agb_admins WHERE user_id=$1`, [tid]);
        return bot.sendMessage(cid, `✅ Admin \`${tid}\` removed.`, { parse_mode: 'Markdown' });
      }

      if (step === 'search') {
        let r;
        if (/^\d+$/.test(text)) r = await run(`SELECT * FROM agb_users WHERE user_id=$1`, [parseInt(text, 10)]);
        else r = await run(`SELECT * FROM agb_users WHERE username ILIKE $1`, [text.replace('@', '')]);
        if (!r.rows.length) return bot.sendMessage(cid, '❌ User not found.');
        const u = r.rows[0];
        const n = u.username ? `@${u.username}` : u.first_name;
        return bot.sendMessage(cid,
          `🔍 *User Found*\n\n👤 *${n}*\n🆔 \`${u.user_id}\`\n` +
          `🔗 Cycle: *${u.cycle_refs}* | Total: *${u.total_refs}*\n` +
          `📦 Orders: *${u.total_orders}*\n🚫 Banned: *${u.is_banned ? 'Yes' : 'No'}*\n` +
          `📅 Joined: ${new Date(u.joined_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] } }
        );
      }

      if (step === 'detail') {
        const tid = parseInt(text, 10);
        if (isNaN(tid)) return bot.sendMessage(cid, '❌ Invalid User ID.');
        const u = await getUser(tid);
        if (!u) return bot.sendMessage(cid, '❌ User not found.');
        const n = u.username ? `@${u.username}` : u.first_name;
        const [orders, refCount] = await Promise.all([
          run(`SELECT id,ordered_at FROM agb_orders WHERE user_id=$1 ORDER BY ordered_at DESC LIMIT 5`, [tid]),
          run(`SELECT COUNT(*) FROM agb_users WHERE referred_by=$1`, [tid]),
        ]);
        let txt =
          `📨 *User Detail*\n\n👤 *${n}*\n🆔 \`${tid}\`\n` +
          `🔗 Cycle: *${u.cycle_refs}* | Total: *${u.total_refs}*\n` +
          `👥 Referrals Made: *${refCount.rows[0].count}*\n` +
          `📦 Total Orders: *${u.total_orders}*\n` +
          `🚫 Banned: *${u.is_banned ? 'Yes' : 'No'}*\n` +
          `📅 ${new Date(u.joined_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n` +
          `📋 *Last 5 Orders:*\n`;
        if (orders.rows.length)
          orders.rows.forEach(o => { txt += `• #${o.id} — ${new Date(o.ordered_at).toLocaleDateString('en-IN')}\n`; });
        else txt += 'No orders yet.';
        return bot.sendMessage(cid, txt, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] },
        });
      }

      if (step === 'resetcycle') {
        const tid = parseInt(text, 10);
        if (isNaN(tid)) return bot.sendMessage(cid, '❌ Invalid User ID.');
        await run(`UPDATE agb_users SET cycle_refs=0 WHERE user_id=$1`, [tid]);
        return bot.sendMessage(cid, `✅ Cycle reset for user \`${tid}\`.`, { parse_mode: 'Markdown' });
      }

      if (step === 'delorder') {
        const oid = parseInt(text, 10);
        if (isNaN(oid)) return bot.sendMessage(cid, '❌ Invalid Order ID.');
        const r = await run(`DELETE FROM agb_orders WHERE id=$1 RETURNING user_id`, [oid]);
        if (!r.rows.length) return bot.sendMessage(cid, `❌ Order #${oid} not found.`);
        await run(`UPDATE agb_users SET total_orders=GREATEST(total_orders-1,0) WHERE user_id=$1`, [r.rows[0].user_id]);
        return bot.sendMessage(cid, `✅ Order #${oid} deleted.`);
      }

      if (step === 'giveprem') {
        const tid = parseInt(text, 10);
        if (isNaN(tid)) return bot.sendMessage(cid, '❌ Invalid User ID.');
        const u = await getUser(tid);
        if (!u) return bot.sendMessage(cid, '❌ User not found.');
        await run(`INSERT INTO agb_orders(user_id) VALUES($1)`, [tid]);
        await run(`UPDATE agb_users SET total_orders=total_orders+1 WHERE user_id=$1`, [tid]);
        try {
          await bot.sendMessage(tid,
            `💎 *Congratulations!*\n\nAdmin has gifted you a *Telegram Premium*!\nYou will receive it shortly. 🎉`,
            { parse_mode: 'Markdown' }
          );
        } catch {}
        return bot.sendMessage(cid, `✅ Premium given to user \`${tid}\`.`, { parse_mode: 'Markdown' });
      }

      if (step === 'setrefs') {
        const n = parseInt(text, 10);
        if (isNaN(n) || n < 1) return bot.sendMessage(cid, '❌ Invalid number.');
        await setSetting('req_refs', String(n));
        return bot.sendMessage(cid, `✅ Required referrals set to *${n}*`, { parse_mode: 'Markdown' });
      }

      if (step === 'userorders') {
        const tid = parseInt(text, 10);
        if (isNaN(tid)) return bot.sendMessage(cid, '❌ Invalid User ID.');
        const r = await run(`SELECT id,ordered_at FROM agb_orders WHERE user_id=$1 ORDER BY ordered_at DESC LIMIT 20`, [tid]);
        const u = await getUser(tid);
        const n = u ? (u.username ? `@${u.username}` : u.first_name) : String(tid);
        let txt = `📦 *Orders for ${n}*\n\n`;
        if (!r.rows.length) txt += 'No orders.';
        r.rows.forEach((o, i) => {
          txt += `${i + 1}. #${o.id} — ${new Date(o.ordered_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n`;
        });
        return bot.sendMessage(cid, txt, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✖️ Close', callback_data: 'ok' }]] },
        });
      }

      return;
    }

    // ── Regular user flow ────────────────────────────────────
    let user = await getUser(uid);
    if (!user) user = await registerUser(uid, fname, msg.from.username || null, null).then(r => r.user);

    if (user?.is_banned)
      return bot.sendMessage(cid, '🚫 You are banned from this bot.');
    if (await isMaintenance() && !(await isAdmin(uid)))
      return bot.sendMessage(cid, '🔧 Bot is under maintenance. Please try again later.', { reply_markup: mainKB() });
    if (!(await checkMember(uid)))
      return showJoin(cid);

    // Delete old popup before new one
    await killPopup(uid);

    const reqRef = parseInt(await getSetting('req_refs') || String(NEED_REFS), 10);

    // ── 🎀 Get Premium ───────────────────────────────────────
    if (text === '🎀 Get Premium') {
      if (!user || user.cycle_refs < reqRef) {
        const sent = await bot.sendMessage(cid,
          `⚠️ *You Need To Invite ${reqRef} User To Get Premium*`,
          { parse_mode: 'Markdown', reply_markup: okKB() }
        );
        lastPop.set(uid, { chatId: cid, msgId: sent.message_id });
      } else {
        const sent = await bot.sendMessage(cid,
          `🎀 *Confirm Premium Order?*\n\nYou have *${user.cycle_refs}/${reqRef}* referrals this cycle.\n\nClaim your Telegram Premium now?`,
          { parse_mode: 'Markdown', reply_markup: confirmKB() }
        );
        lastPop.set(uid, { chatId: cid, msgId: sent.message_id });
      }

    // ── 💀 Invitation ────────────────────────────────────────
    } else if (text === '💀 Invitation') {
      const refs = user?.cycle_refs || 0;
      const sent = await bot.sendMessage(cid,
        `Hey ${fname} 👋\n\n✈️ *Your Total Invitation: ${refs}/${reqRef} User(s)*\n\n💀 *Invitation Link:* https://t.me/${BOT_USER}?start=${uid}`,
        { parse_mode: 'Markdown', reply_markup: okKB() }
      );
      lastPop.set(uid, { chatId: cid, msgId: sent.message_id });

    // ── 🐶 Statistics ─────────────────────────────────────────
    } else if (text === '🐶 Statistics') {
      const sent = await bot.sendMessage(cid,
        `👤 *Total Users = ${STATIC_USERS}*\n\n💸 *Total Withdraw = ${STATIC_WITHDRAW} Premium*`,
        { parse_mode: 'Markdown', reply_markup: okKB() }
      );
      lastPop.set(uid, { chatId: cid, msgId: sent.message_id });

    } else {
      await showMain(cid);
    }

  } catch (e) { console.error('Msg:', e.message); }
});

bot.on('polling_error', e => console.error('Poll:', e.message));

// ═══════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════
console.log(`🤖 ${BOT_NAME} starting...`);
initDB().catch(e => { console.error('Fatal DB:', e.message); process.exit(1); });
