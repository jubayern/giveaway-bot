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

function cfg() {
  return {
    BOT_TOKEN: mustEnv("BOT_TOKEN"),
    OWNER_ID: numEnv("OWNER_ID"),
    START_LOG_CHANNEL_ID: numEnv("START_LOG_CHANNEL_ID"),
    SUPPORT_CHANNEL_ID: numEnv("SUPPORT_CHANNEL_ID"),
    ADMIN_LOG_CHAT_ID: numEnv("ADMIN_LOG_CHAT_ID"),
  };
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

async function sendHtml(ctx, chatId, html, extra) {
  return ctx.telegram.sendMessage(chatId, html, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(extra || {}),
  });
}

async function safeSendHtml(ctx, chatId, html, extra) {
  try {
    await sendHtml(ctx, chatId, html, extra);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

const UI = {
  welcome: () =>
    [
      hBold("Welcome to Giveaway By Tayven"),
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
      "You do not have permission to access this panel.",
      "",
      fmtUtcLine(),
    ].join("\n"),
};

const KEYS = {
  adminsSet: "admins:set",
  usersStartedSet: "users:started:set",
  usersStartedZ: "users:started:z",
  giveawaysActiveSet: "giveaways:active:set",
};
function isOwner(ctx) {
  return ctx.from?.id === cfg().OWNER_ID;
}

async function isAdmin(ctx) {
  if (isOwner(ctx)) return true;
  const r = getRedis();
  const uid = ctx.from?.id;
  if (!uid) return false;
  return await r.sismember(KEYS.adminsSet, String(uid));
}

async function requireAdmin(ctx) {
  if (!(await isAdmin(ctx))) {
    await ctx.reply(UI.accessDenied(), { parse_mode: "HTML", disable_web_page_preview: true });
    return false;
  }
  return true;
}

function kbMainAdmin() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎁 Giveaways", "a_giveaways")],
    [Markup.button.callback("👥 Users", "a_users")],
    [Markup.button.callback("📣 Messaging", "a_messaging")],
    [Markup.button.callback("📊 Statistics", "a_stats")],
    [Markup.button.callback("⚙️ Settings", "a_settings")],
  ]);
}

function kbBack() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "a_back")]]);
}

function kbGiveaways() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Create Giveaway", "a_g_create")],
    [Markup.button.callback("📋 List Giveaways", "a_g_list")],
    [Markup.button.callback("⏸ Freeze Giveaway", "a_g_freeze")],
    [Markup.button.callback("📸 Snapshot", "a_g_snapshot")],
    [Markup.button.callback("🎲 Pick Winners", "a_g_pick")],
    [Markup.button.callback("🏁 Close Giveaway", "a_g_close")],
    [Markup.button.callback("⬅️ Back", "a_back")],
  ]);
}

function kbMessaging() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📌 Send Notice (All Users)", "a_notice_all")],
    [Markup.button.callback("✉️ Message Single User", "a_msg_user")],
    [Markup.button.callback("🎁 Notify Winners (Bulk)", "a_notify_winners")],
    [Markup.button.callback("⬅️ Back", "a_back")],
  ]);
}

function kbSettings(isOwnerUser) {
  const rows = [];
  if (isOwnerUser) {
    rows.push([Markup.button.callback("👤 Admin Management", "a_admins")]);
  }
  rows.push([Markup.button.callback("⬅️ Back", "a_back")]);
  return Markup.inlineKeyboard(rows);
}

function kbAdminManagement() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add Admin", "a_admin_add")],
    [Markup.button.callback("➖ Remove Admin", "a_admin_remove")],
    [Markup.button.callback("⬅️ Back", "a_back")],
  ]);
}
function getBot() {
  if (bot) return bot;

  const C = cfg();
  bot = new Telegraf(C.BOT_TOKEN);

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
          `<pre>userId: ${esc(String(uid))}\nusername: ${esc(
            ctx.from?.username ? "@" + ctx.from.username : "no_username"
          )}\nutc: ${esc(utcIso())}</pre>`,
          userMention(ctx.from),
        ].join("\n");

        await safeSendHtml(ctx, C.START_LOG_CHANNEL_ID, html);
      }
    }

    await ctx.reply(UI.welcome(), { parse_mode: "HTML", disable_web_page_preview: true });
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
        [
          hBold("Active Giveaway"),
          "",
          `Giveaway ID: <pre>${esc(gids[0])}</pre>`,
          "",
          "Next: we will render full giveaway details + join/verify buttons in Phase-C.",
          "",
          fmtUtcLine(),
          footer(),
        ].join("\n"),
        { parse_mode: "HTML", disable_web_page_preview: true }
      );
      return;
    }

    await ctx.reply(
      [
        hBold("Select a Giveaway"),
        "",
        "Multiple giveaways are active. Please choose one:",
        "",
        fmtUtcLine(),
        footer(),
      ].join("\n"),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(gids.map((gid) => [Markup.button.callback(`${gid}`, `u_g_view:${gid}`)])),
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
        [
          hBold("Your Status"),
          "",
          "You have no participation record yet.",
          "Use /giveaway to view active giveaways.",
          "",
          fmtUtcLine(),
          footer(),
        ].join("\n"),
        { parse_mode: "HTML", disable_web_page_preview: true }
      );
      return;
    }

    await ctx.reply(
      [hBold("Select a Giveaway to View Status"), "", fmtUtcLine(), footer()].join("\n"),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(gids.map((gid) => [Markup.button.callback(`${gid}`, `u_status:${gid}`)])),
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
      `<pre>userId: ${esc(String(uid ?? "unknown"))}\nusername: ${esc(uname)}\nutc: ${esc(utcIso())}</pre>`,
      hBold("Message"),
      `<blockquote>${esc(text)}</blockquote>`,
      "",
      userMention(ctx.from),
    ].join("\n");

    await safeSendHtml(ctx, C.SUPPORT_CHANNEL_ID, html);
    await ctx.reply(UI.contactAck(), { parse_mode: "HTML", disable_web_page_preview: true });
  });

  bot.action(/^u_g_view:(.+)$/i, async (ctx) => {
    const gid = String(ctx.match[1] || "").trim();
    await ctx.answerCbQuery();

    await ctx.reply(
      [
        hBold("Giveaway Details"),
        "",
        `Giveaway ID: <pre>${esc(gid)}</pre>`,
        "",
        "Next: full details + join/verify buttons in Phase-C.",
        "",
        fmtUtcLine(),
        footer(),
      ].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  });

  bot.action(/^u_status:(.+)$/i, async (ctx) => {
    const gid = String(ctx.match[1] || "").trim();
    await ctx.answerCbQuery();

    await ctx.reply(
      [
        hBold("Status Details"),
        "",
        `Giveaway ID: <pre>${esc(gid)}</pre>`,
        "",
        "Next: status rendering in Phase-C.",
        "",
        fmtUtcLine(),
        footer(),
      ].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  });

  bot.command("admin", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;

    await ctx.reply(
      [hBold("Admin Control Panel"), "", "Select a section:", "", fmtUtcLine()].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true, ...kbMainAdmin() }
    );
  });

  bot.action("a_back", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    try {
      await ctx.editMessageText(
        [hBold("Admin Control Panel"), "", "Select a section:", "", fmtUtcLine()].join("\n"),
        { parse_mode: "HTML", disable_web_page_preview: true, ...kbMainAdmin() }
      );
    } catch (e) {
      await ctx.reply(
        [hBold("Admin Control Panel"), "", "Select a section:", "", fmtUtcLine()].join("\n"),
        { parse_mode: "HTML", disable_web_page_preview: true, ...kbMainAdmin() }
      );
    }
  });

  bot.action("a_giveaways", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await ctx.editMessageText(
      [hBold("Giveaways"), "", "Manage giveaway lifecycle from here.", "", fmtUtcLine()].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true, ...kbGiveaways() }
    );
  });

  bot.action("a_users", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await ctx.editMessageText(
      [hBold("Users"), "", "Next: user search + profile actions in Phase-C.", "", fmtUtcLine()].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true, ...kbBack() }
    );
  });

  bot.action("a_messaging", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await ctx.editMessageText(
      [hBold("System Messaging"), "", "Broadcast & direct messaging tools.", "", fmtUtcLine()].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true, ...kbMessaging() }
    );
  });

  bot.action("a_stats", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await ctx.editMessageText(
      [
        hBold("Bot Statistics"),
        "",
        "Next: detailed stats in Phase-C.",
        "• users started",
        "• active giveaways",
        "• participants by status",
        "• winners & claims",
        "",
        fmtUtcLine(),
      ].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true, ...kbBack() }
    );
  });

  bot.action("a_settings", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await ctx.editMessageText(
      [hBold("System Settings"), "", "Global settings for admins only.", "", fmtUtcLine()].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true, ...kbSettings(isOwner(ctx)) }
    );
  });

  bot.action("a_admins", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isOwner(ctx)) {
      await ctx.reply(UI.accessDenied(), { parse_mode: "HTML", disable_web_page_preview: true });
      return;
    }

    await ctx.editMessageText(
      [hBold("Admin Management"), "", "Add or remove bot admins.", "", fmtUtcLine()].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true, ...kbAdminManagement() }
    );
  });

  bot.action("a_admin_add", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isOwner(ctx)) {
      await ctx.reply(UI.accessDenied(), { parse_mode: "HTML", disable_web_page_preview: true });
      return;
    }
    await ctx.reply(
      [
        hBold("Add Admin"),
        "",
        "Next (Phase-C): will ask for userId and add to admins list.",
        "",
        fmtUtcLine(),
      ].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  });

  bot.action("a_admin_remove", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isOwner(ctx)) {
      await ctx.reply(UI.accessDenied(), { parse_mode: "HTML", disable_web_page_preview: true });
      return;
    }
    await ctx.reply(
      [
        hBold("Remove Admin"),
        "",
        "Next (Phase-C): will ask for userId and remove from admins list.",
        "",
        fmtUtcLine(),
      ].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  });

  bot.action(/^(a_g_create|a_g_list|a_g_freeze|a_g_snapshot|a_g_pick|a_g_close)$/i, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await ctx.reply(
      [hBold("Coming in Phase-C"), "", `Action: <pre>${esc(ctx.match[1])}</pre>`, "", fmtUtcLine()].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  });

  bot.action(/^(a_notice_all|a_msg_user|a_notify_winners)$/i, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireAdmin(ctx))) return;

    await ctx.reply(
      [hBold("Coming in Phase-C"), "", `Action: <pre>${esc(ctx.match[1])}</pre>`, "", fmtUtcLine()].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  });

  bot.on("message", async (ctx) => {
    if (ctx.message?.text?.startsWith("/")) {
      await ctx.reply("Unknown command.");
    }
  });

  return bot;
}
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
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
