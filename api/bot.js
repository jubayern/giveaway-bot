cat >> api/bot.js <<'EOF'
const { Telegraf, Markup } = require("telegraf");
const { Redis } = require("@upstash/redis");

let bot;
let redis;

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function numEnv(name) {
  const v = mustEnv(name);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${name}`);
  return n;
}

function utcIso() {
  return new Date().toISOString();
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function hBold(s) {
  return `<b>${esc(s)}</b>`;
}

function footer() {
  return `\n\n—\nFor help: /contact`;
}

function fmtUtcLine() {
  const iso = utcIso().replace("T", " ").replace("Z", " UTC");
  return `Time: ${esc(iso)}`;
}

function userMention(from) {
  const id = from?.id;
  const name =
    `${from?.first_name ?? ""}${from?.last_name ? " " + from.last_name : ""}`.trim() || "User";
  if (!id) return esc(name);
  return `<a href="tg://user?id=${id}">${esc(name)}</a>`;
}

function getRedis() {
  if (redis) return redis;
  redis = new Redis({
    url: mustEnv("UPSTASH_REDIS_REST_URL"),
    token: mustEnv("UPSTASH_REDIS_REST_TOKEN"),
  });
  return redis;
}

function cfg() {
  return {
    BOT_TOKEN: mustEnv("BOT_TOKEN"),
    OWNER_ID: numEnv("OWNER_ID"),
    START_LOG_CHANNEL_ID: numEnv("START_LOG_CHANNEL_ID"),
    SUPPORT_CHANNEL_ID: numEnv("SUPPORT_CHANNEL_ID"),
    ADMIN_LOG_CHAT_ID: numEnv("ADMIN_LOG_CHAT_ID"),
  };
}

async function sendHtml(ctx, chatId, html, extra) {
  return ctx.telegram.sendMessage(chatId, html, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(extra || {}),
  });
}

async function safeSendHtml(ctx, chatId, html) {
  try {
    await sendHtml(ctx, chatId, html);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

const UI = {
  welcome: () =>
    [
      hBold("Welcome to the Giveaway Bot"),
      "",
      "Commands:",
      "• /giveaway — View active giveaways",
      "• /status — Check your status",
      "• /contact — Contact support",
      "",
      fmtUtcLine(),
      footer(),
    ].join("\n"),

  noActiveGiveaway: () =>
    [
      hBold("No Active Giveaway"),
      "",
      "There is no active giveaway at the moment.",
      "Please check again later.",
      "",
      fmtUtcLine(),
      footer(),
    ].join("\n"),

  contactUsage: () =>
    [
      hBold("Contact Support"),
      "",
      "Send your message like this:",
      "<pre>/contact your message here</pre>",
      "",
      fmtUtcLine(),
      footer(),
    ].join("\n"),

  contactAck: () =>
    [
      hBold("Support Request Received"),
      "",
      "Your message has been sent to the support inbox.",
      "",
      fmtUtcLine(),
      footer(),
    ].join("\n"),

  accessDenied: () =>
    [
      hBold("Access Denied"),
      "",
      "You do not have permission to use this panel.",
      "",
      fmtUtcLine(),
    ].join("\n"),

  comingSoon: () =>
    [
      hBold("Coming Soon"),
      "",
      "This section is available in the next step.",
      "",
      fmtUtcLine(),
    ].join("\n"),
};

const KEYS = {
  usersStartedSet: "users:started:set",
  usersStartedZ: "users:started:z",
  giveawaysActiveSet: "giveaways:active:set",
  giveawaysAllZ: "giveaways:all:z",
  giveawaysDraftSet: "giveaways:draft:set",
  giveawayMeta: (gid) => `giveaway:${gid}:meta`,
  adminsSet: "admins:set",
  adminWiz: (chatId) => `admin:wiz:${String(chatId)}`,
};

function newGid() {
  return "gw_" + Date.now().toString(36);
}

function isOwnerId(userId) {
  return Number(userId) === cfg().OWNER_ID;
}

async function isAdminId(userId) {
  if (!userId) return false;
  if (isOwnerId(userId)) return true;
  const r = getRedis();
  return (await r.sismember(KEYS.adminsSet, String(userId))) === 1;
}

async function requireAdmin(ctx) {
  const ok = await isAdminId(ctx.from?.id);
  if (!ok) {
    await ctx.reply(UI.accessDenied(), { parse_mode: "HTML", disable_web_page_preview: true });
    return false;
  }
  return true;
}

async function logAdmin(ctx, html) {
  const C = cfg();
  await safeSendHtml(ctx, C.ADMIN_LOG_CHAT_ID, html);
}

function adminMainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎁 Giveaways", "a:giveaways"), Markup.button.callback("👥 Users", "a:users")],
    [Markup.button.callback("🏆 Winners & Claims", "a:winners"), Markup.button.callback("📣 Messaging", "a:messaging")],
    [Markup.button.callback("🧾 Logs", "a:logs"), Markup.button.callback("📊 Stats", "a:stats")],
    [Markup.button.callback("⚙️ Settings", "a:settings")],
  ]);
}

function backBtn() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "a:home")]]);
}

async function setWiz(r, chatId, obj) {
  await r.set(KEYS.adminWiz(chatId), JSON.stringify(obj), { ex: 1800 });
}

async function getWiz(r, chatId) {
  const v = await r.get(KEYS.adminWiz(chatId));
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function clearWiz(r, chatId) {
  await r.del(KEYS.adminWiz(chatId));
}

async function replyOrEdit(ctx, html, keyboard) {
  const extra = {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? keyboard : {}),
  };

  try {
    if (ctx.updateType === "callback_query") {
      await ctx.editMessageText(html, extra);
      return;
    }
  } catch {}

  await ctx.reply(html, extra);
}

async function broadcastNotice(ctx, text) {
  const r = getRedis();
  const max = 120;
  const ids = await r.zrange(KEYS.usersStartedZ, 0, max - 1);

  let sent = 0;
  let failed = 0;

  const html = [hBold("Notice"), "", `<blockquote>${esc(text)}</blockquote>`, "", fmtUtcLine()].join("\n");

  for (const uid of ids || []) {
    const res = await safeSendHtml(ctx, Number(uid), html);
    if (res.ok) sent += 1;
    else failed += 1;
  }

  return { sent, failed, sample: (ids || []).length, max };
}
EOF
cat >> api/bot.js <<'EOF'
function getBot() {
  if (bot) return bot;

  const C = cfg();
  bot = new Telegraf(C.BOT_TOKEN);

  bot.catch(async (err, ctx) => {
    try {
      const msg = String(err?.message || err);
      const html = [hBold("Bot Error"), "", `<pre>${esc(msg).slice(0, 3500)}</pre>`, fmtUtcLine()].join("\n");
      await logAdmin(ctx, html);
    } catch {}
  });

  bot.command("start", async (ctx) => {
    const r = getRedis();
    const uid = ctx.from?.id;
    const now = Date.now();

    if (uid) {
      const firstSeen = await r.sadd(KEYS.usersStartedSet, String(uid));
      await r.zadd(KEYS.usersStartedZ, { score: now, member: String(uid) });

      if (firstSeen === 1) {
        const html = [
          hBold("New User Started"),
          "",
          `<pre>userId: ${esc(String(uid))}
username: ${esc(ctx.from?.username ? "@" + ctx.from.username : "no_username")}
utc: ${esc(utcIso())}</pre>`,
          userMention(ctx.from),
        ].join("\n");

        await safeSendHtml(ctx, C.START_LOG_CHANNEL_ID, html);
      }
    }

    await ctx.reply(UI.welcome(), { parse_mode: "HTML", disable_web_page_preview: true });
  });

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  bot.command("giveaway", async (ctx) => {
    const r = getRedis();
    const active = await r.smembers(KEYS.giveawaysActiveSet);

    if (!active || active.length === 0) {
      await ctx.reply(UI.noActiveGiveaway(), { parse_mode: "HTML", disable_web_page_preview: true });
      return;
    }

    const gids = active.map(String);

    if (gids.length === 1) {
      await ctx.reply(
        [hBold("Active Giveaway"), "", `Giveaway ID: <pre>${esc(gids[0])}</pre>`, "", fmtUtcLine(), footer()].join("\n"),
        { parse_mode: "HTML", disable_web_page_preview: true }
      );
      return;
    }

    await ctx.reply(
      [hBold("Select a Giveaway"), "", "Multiple giveaways are active. Choose one:", "", fmtUtcLine(), footer()].join("\n"),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(gids.map((gid) => [Markup.button.callback(`${gid}`, `u:view:${gid}`)])),
      }
    );
  });

  bot.command("status", async (ctx) => {
    const r = getRedis();
    const uid = ctx.from?.id;
    if (!uid) {
      await ctx.reply("Unable to read your userId.");
      return;
    }

    const active = await r.smembers(KEYS.giveawaysActiveSet);
    const gids = (active || []).map(String);

    if (gids.length === 0) {
      await ctx.reply(
        [hBold("Your Status"), "", "No active giveaway found.", "Use /giveaway to check.", "", fmtUtcLine(), footer()].join("\n"),
        { parse_mode: "HTML", disable_web_page_preview: true }
      );
      return;
    }

    await ctx.reply(
      [hBold("Select a Giveaway to View Status"), "", fmtUtcLine(), footer()].join("\n"),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(gids.map((gid) => [Markup.button.callback(`${gid}`, `u:status:${gid}`)])),
      }
    );
  });

  bot.command("contact", async (ctx) => {
    const msg = ctx.message?.text || "";
    const text = msg.replace(/^\/contact(@\w+)?\s*/i, "").trim();

    if (!text) {
      await ctx.reply(UI.contactUsage(), { parse_mode: "HTML", disable_web_page_preview: true });
      return;
    }

    const uid = ctx.from?.id;
    const uname = ctx.from?.username ? "@" + ctx.from.username : "no_username";

    const html = [
      hBold("Support Message"),
      "",
      `<pre>userId: ${esc(String(uid ?? "unknown"))}
username: ${esc(uname)}
utc: ${esc(utcIso())}</pre>`,
      hBold("Message"),
      `<blockquote>${esc(text)}</blockquote>`,
      "",
      userMention(ctx.from),
    ].join("\n");

    await safeSendHtml(ctx, C.SUPPORT_CHANNEL_ID, html);
    await ctx.reply(UI.contactAck(), { parse_mode: "HTML", disable_web_page_preview: true });
  });

  bot.action(/^u:view:(.+)$/i, async (ctx) => {
    await ctx.answerCbQuery();
    const gid = String(ctx.match[1] || "").trim();
    await ctx.reply([hBold("Giveaway Details"), "", `Giveaway ID: <pre>${esc(gid)}</pre>`, "", fmtUtcLine(), footer()].join("\n"), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  });

  bot.action(/^u:status:(.+)$/i, async (ctx) => {
    await ctx.answerCbQuery();
    const gid = String(ctx.match[1] || "").trim();
    await ctx.reply([hBold("Status Details"), "", `Giveaway ID: <pre>${esc(gid)}</pre>`, "", fmtUtcLine(), footer()].join("\n"), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  });
EOF
cat >> api/bot.js <<'EOF'
  bot.command("admin", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;

    await replyOrEdit(ctx, [hBold("Admin Control Panel"), "", "Choose a section:", "", fmtUtcLine()].join("\n"), adminMainKeyboard());
  });

  bot.action("a:home", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await replyOrEdit(ctx, [hBold("Admin Control Panel"), "", "Choose a section:", "", fmtUtcLine()].join("\n"), adminMainKeyboard());
  });

  bot.action("a:giveaways", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await replyOrEdit(
      ctx,
      [hBold("Giveaways"), "", "Manage giveaway lifecycle:", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Create (Wizard)", "a:g:create"), Markup.button.callback("📋 List", "a:g:list")],
        [Markup.button.callback("🟢 Open", "a:g:open"), Markup.button.callback("🧊 Freeze", "a:g:freeze")],
        [Markup.button.callback("📸 Snapshot", "a:g:snapshot"), Markup.button.callback("⛔ Close", "a:g:close")],
        [Markup.button.callback("⬅️ Back", "a:home")],
      ])
    );
  });

  bot.action("a:g:create", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    const r = getRedis();
    const gid = newGid();

    await setWiz(r, ctx.chat.id, { t: "gw_create", step: "title", gid, data: {} });

    await ctx.reply(
      [hBold("Create Giveaway — Step 1/2"), "", "Please enter the giveaway title.", "Minimum: 5 characters.", "", fmtUtcLine()].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  });

  bot.action("a:users", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await replyOrEdit(
      ctx,
      [hBold("Users"), "", "User tools:", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("🔎 Find User", "a:u:find"), Markup.button.callback("🧷 Lock User", "a:u:lock")],
        [Markup.button.callback("🔓 Unlock User", "a:u:unlock"), Markup.button.callback("✅ Make VALID", "a:u:valid")],
        [Markup.button.callback("🚫 Make INVALID", "a:u:invalid"), Markup.button.callback("✉️ Message User", "a:u:msg")],
        [Markup.button.callback("⬅️ Back", "a:home")],
      ])
    );
  });

  bot.action("a:winners", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await replyOrEdit(
      ctx,
      [hBold("Winners & Claims"), "", "Winner selection and claim tools:", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("🎲 Pick Winners", "a:w:pick"), Markup.button.callback("📣 Notify Winners", "a:w:notify")],
        [Markup.button.callback("✉️ Send Claim (1-by-1)", "a:w:sendclaim"), Markup.button.callback("🔁 Resend Claim", "a:w:resend")],
        [Markup.button.callback("⏱ Override Expired", "a:w:override"), Markup.button.callback("🚫 Disqualify Winner", "a:w:disq")],
        [Markup.button.callback("⬅️ Back", "a:home")],
      ])
    );
  });

  bot.action("a:messaging", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await replyOrEdit(
      ctx,
      [hBold("Messaging"), "", "Notices and direct messaging:", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("📌 Send Notice (All Users)", "a:m:notice")],
        [Markup.button.callback("✉️ Message Single User", "a:m:one")],
        [Markup.button.callback("⬅️ Back", "a:home")],
      ])
    );
  });

  bot.action("a:logs", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;
    await replyOrEdit(ctx, [hBold("Logs"), "", "Operational logs:", "", "• Starts", "• Contacts", "• Admin actions", "• Delivery failures", "", fmtUtcLine()].join("\n"), backBtn());
  });

  bot.action("a:stats", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;
    await replyOrEdit(ctx, [hBold("Stats"), "", "High-level statistics will be shown here.", "", fmtUtcLine()].join("\n"), backBtn());
  });

  bot.action("a:settings", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await replyOrEdit(
      ctx,
      [hBold("Settings"), "", "Admin-only system settings:", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("👤 Admin Management", "a:s:admins")],
        [Markup.button.callback("⬅️ Back", "a:home")],
      ])
    );
  });
EOF
cat >> api/bot.js <<'EOF'
  bot.action("a:s:admins", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    if (!isOwnerId(ctx.from?.id)) {
      await replyOrEdit(ctx, [hBold("Admin Management"), "", "Only the owner can manage admins.", "", fmtUtcLine()].join("\n"), backBtn());
      return;
    }

    await replyOrEdit(
      ctx,
      [hBold("Admin Management"), "", "Choose an action:", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Add Admin", "a:s:admins:add"), Markup.button.callback("➖ Remove Admin", "a:s:admins:remove")],
        [Markup.button.callback("📋 List Admins", "a:s:admins:list")],
        [Markup.button.callback("⬅️ Back", "a:settings")],
      ])
    );
  });

  bot.action("a:s:admins:add", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isOwnerId(ctx.from?.id)) return;

    const r = getRedis();
    await setWiz(r, ctx.chat.id, { t: "add_admin" });

    await replyOrEdit(
      ctx,
      [hBold("Add Admin"), "", "Send the userId now (numbers only).", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Cancel", "a:wiz:cancel")]])
    );
  });

  bot.action("a:s:admins:remove", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isOwnerId(ctx.from?.id)) return;

    const r = getRedis();
    await setWiz(r, ctx.chat.id, { t: "remove_admin" });

    await replyOrEdit(
      ctx,
      [hBold("Remove Admin"), "", "Send the userId now (numbers only).", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Cancel", "a:wiz:cancel")]])
    );
  });

  bot.action("a:s:admins:list", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isOwnerId(ctx.from?.id)) return;

    const r = getRedis();
    const list = await r.smembers(KEYS.adminsSet);

    await replyOrEdit(
      ctx,
      [hBold("Admin List"), "", `<pre>${esc((list || []).join("\n") || "No admins")}</pre>`, "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "a:s:admins")]])
    );
  });

  bot.action("a:m:notice", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    const r = getRedis();
    await setWiz(r, ctx.chat.id, { t: "notice_all" });

    await replyOrEdit(
      ctx,
      [hBold("Send Notice"), "", "Type your notice text now.", "", "It will be sent to a sample batch to avoid timeouts.", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Cancel", "a:wiz:cancel")]])
    );
  });

  bot.action("a:wiz:cancel", async (ctx) => {
    await ctx.answerCbQuery();
    const r = getRedis();
    await clearWiz(r, ctx.chat.id);
    await replyOrEdit(ctx, [hBold("Cancelled"), "", "Action cancelled.", "", fmtUtcLine()].join("\n"), backBtn());
  });

  bot.action(/^a:(g|u|w|m):/i, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;
    await ctx.reply(UI.comingSoon(), { parse_mode: "HTML", disable_web_page_preview: true });
  });

  bot.on("text", async (ctx, next) => {
    const r = getRedis();
    const wiz = await getWiz(r, ctx.chat.id);
    if (!wiz) return next();

    const text = String(ctx.message?.text || "").trim();

    if (wiz.t === "add_admin") {
      if (!/^\d+$/.test(text)) {
        await ctx.reply("Send a numeric userId only.");
        return;
      }
      await r.sadd(KEYS.adminsSet, text);
      await clearWiz(r, ctx.chat.id);

      await logAdmin(ctx, [hBold("Admin Added"), "", `<pre>userId: ${esc(text)}\nutc: ${esc(utcIso())}</pre>`].join("\n"));
      await ctx.reply([hBold("Done"), "", `Admin added: <pre>${esc(text)}</pre>`, "", fmtUtcLine()].join("\n"), {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return;
    }

    if (wiz.t === "remove_admin") {
      if (!/^\d+$/.test(text)) {
        await ctx.reply("Send a numeric userId only.");
        return;
      }
      await r.srem(KEYS.adminsSet, text);
      await clearWiz(r, ctx.chat.id);

      await logAdmin(ctx, [hBold("Admin Removed"), "", `<pre>userId: ${esc(text)}\nutc: ${esc(utcIso())}</pre>`].join("\n"));
      await ctx.reply([hBold("Done"), "", `Admin removed: <pre>${esc(text)}</pre>`, "", fmtUtcLine()].join("\n"), {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return;
    }

    if (wiz.t === "notice_all") {
      if (!text) {
        await ctx.reply("Notice text cannot be empty.");
        return;
      }

      await clearWiz(r, ctx.chat.id);
      const res = await broadcastNotice(ctx, text);

      await logAdmin(
        ctx,
        [
          hBold("Notice Sent (Batch)"),
          "",
          `<pre>sent: ${esc(String(res.sent))}
failed: ${esc(String(res.failed))}
sample: ${esc(String(res.sample))}
max: ${esc(String(res.max))}
utc: ${esc(utcIso())}</pre>`,
        ].join("\n")
      );

      await ctx.reply(
        [hBold("Notice Sent"), "", `Sent: <pre>${esc(String(res.sent))}</pre>`, `Failed: <pre>${esc(String(res.failed))}</pre>`, "", fmtUtcLine()].join("\n"),
        { parse_mode: "HTML", disable_web_page_preview: true }
      );
      return;
    }

    if (wiz.t === "gw_create") {
      if (wiz.step === "title") {
        if (text.length < 5) {
          await ctx.reply("Title must be at least 5 characters.");
          return;
        }

        wiz.data = wiz.data || {};
        wiz.data.title = text;
        wiz.step = "details";
        await setWiz(r, ctx.chat.id, wiz);

        await ctx.reply(
          [hBold("Create Giveaway — Step 2/2"), "", "Now enter giveaway details / description.", "You can write multiple lines.", "", fmtUtcLine()].join("\n"),
          { parse_mode: "HTML", disable_web_page_preview: true }
        );
        return;
      }

      if (wiz.step === "details") {
        wiz.data = wiz.data || {};
        wiz.data.details = text;

        const nowIso = utcIso();
        const metaKey = KEYS.giveawayMeta(wiz.gid);

        await r.hset(metaKey, {
          gid: wiz.gid,
          state: "DRAFT",
          title: wiz.data.title,
          details: wiz.data.details,
          createdAt: nowIso,
          createdBy: String(ctx.from?.id || ""),
        });

        await r.zadd(KEYS.giveawaysAllZ, { score: Date.now(), member: String(wiz.gid) });
        await r.sadd(KEYS.giveawaysDraftSet, String(wiz.gid));

        await clearWiz(r, ctx.chat.id);

        await ctx.reply(
          [
            hBold("Giveaway Created (DRAFT)"),
            "",
            `ID: <pre>${esc(wiz.gid)}</pre>`,
            "",
            hBold("Title"),
            `<blockquote>${esc(wiz.data.title)}</blockquote>`,
            hBold("Details"),
            `<blockquote>${esc(wiz.data.details)}</blockquote>`,
            "",
            "Next: Rules, Channels, Winners, Claim Duration will be added in Part-2.",
            "",
            fmtUtcLine(),
          ].join("\n"),
          { parse_mode: "HTML", disable_web_page_preview: true }
        );

        await logAdmin(
          ctx,
          [hBold("Giveaway Draft Created"), "", `<pre>gid: ${esc(wiz.gid)}\nby: ${esc(String(ctx.from?.id || ""))}\nutc: ${esc(nowIso)}</pre>`].join("\n")
        );
        return;
      }

      await clearWiz(r, ctx.chat.id);
      await ctx.reply("Wizard state invalid. Please start again.");
      return;
    }

    await clearWiz(r, ctx.chat.id);
    return next();
  });

  bot.on("message", async (ctx) => {
    if (ctx.message?.text?.startsWith("/")) {
      await ctx.reply("Unknown command.");
    }
  });

  return bot;
}
EOF
cat >> api/bot.js <<'EOF'
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw || "{}");
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("OK");
      return;
    }

    const b = getBot();
    const update = await readJsonBody(req);
    await b.handleUpdate(update);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
};
EOF

