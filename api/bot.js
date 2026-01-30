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

function safeAnswerCb(ctx) {
  return ctx.answerCbQuery().catch(() => {});
}

function safeEdit(ctx, html, extra) {
  return ctx
    .editMessageText(html, { parse_mode: "HTML", disable_web_page_preview: true, ...(extra || {}) })
    .catch(async () => {
      await ctx.reply(html, { parse_mode: "HTML", disable_web_page_preview: true, ...(extra || {}) }).catch(() => {});
    });
}

function safeReply(ctx, html, extra) {
  return ctx.reply(html, { parse_mode: "HTML", disable_web_page_preview: true, ...(extra || {}) }).catch(() => {});
}

/* =========================
   USER MESSAGE TEMPLATES
========================= */

const UI = {
  welcome: () =>
    [
      hBold("Welcome to the Giveaway Bot"),
      "",
      "Use the commands below:",
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
};

/* =========================
   REDIS KEYS
========================= */

const KEYS = {
  usersStartedSet: "users:started:set",
  usersStartedZ: "users:started:z",
  giveawaysAllZ: "giveaways:all:z",
  giveawaysActiveSet: "giveaways:active:set",
  giveawayMeta: (gid) => `giveaway:${gid}:meta:hash`,
  giveawaySettings: (gid) => `giveaway:${gid}:settings:hash`,
};
/* =========================
   BOT
========================= */

function getBot() {
  if (bot) return bot;

  const C = cfg();
  bot = new Telegraf(C.BOT_TOKEN);

  bot.catch((err) => {
    console.error("BOT_CATCH", err);
  });

  function isOwner(ctx) {
    return ctx.from?.id === C.OWNER_ID;
  }

  async function isAdmin(ctx) {
    if (isOwner(ctx)) return true;
    const r = getRedis();
    return await r.sismember("admins:set", String(ctx.from?.id));
  }

  async function requireAdmin(ctx) {
    if (!(await isAdmin(ctx))) {
      await safeReply(ctx, hBold("Access denied."), {});
      return false;
    }
    return true;
  }

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong").catch(() => {});
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
          `<pre>userId: ${esc(String(uid))}\nusername: ${esc(ctx.from?.username ? "@" + ctx.from.username : "no_username")}\nutc: ${esc(utcIso())}</pre>`,
          userMention(ctx.from),
        ].join("\n");

        await safeSendHtml(ctx, C.START_LOG_CHANNEL_ID, html);
      }
    }

    await safeReply(ctx, UI.welcome());
  });

  bot.command("giveaway", async (ctx) => {
    const r = getRedis();

    const active = await r.smembers(KEYS.giveawaysActiveSet);
    if (!active || active.length === 0) {
      await safeReply(ctx, UI.noActiveGiveaway());
      return;
    }

    const gids = active.map(String);

    if (gids.length === 1) {
      await safeReply(
        ctx,
        [
          hBold("Active Giveaway"),
          "",
          `Giveaway ID: <pre>${esc(gids[0])}</pre>`,
          "",
          "Details will appear here in the next part.",
          "",
          fmtUtcLine(),
          footer(),
        ].join("\n")
      );
      return;
    }

    await safeReply(
      ctx,
      [
        hBold("Select a Giveaway"),
        "",
        "Multiple giveaways are active. Please choose one:",
        "",
        fmtUtcLine(),
        footer(),
      ].join("\n"),
      Markup.inlineKeyboard(gids.map((gid) => [Markup.button.callback(`${gid}`, `u_g_view:${gid}`)]))
    );
  });

  bot.command("status", async (ctx) => {
    const r = getRedis();
    const uid = ctx.from?.id;
    if (!uid) {
      await ctx.reply("Unable to read your userId.").catch(() => {});
      return;
    }

    const active = await r.smembers(KEYS.giveawaysActiveSet);
    const gids = (active || []).map(String);

    if (gids.length === 0) {
      await safeReply(
        ctx,
        [
          hBold("Your Status"),
          "",
          "You have no participation record yet.",
          "Use /giveaway to view active giveaways.",
          "",
          fmtUtcLine(),
          footer(),
        ].join("\n")
      );
      return;
    }

    await safeReply(
      ctx,
      [hBold("Select a Giveaway to View Status"), "", fmtUtcLine(), footer()].join("\n"),
      Markup.inlineKeyboard(gids.map((gid) => [Markup.button.callback(`${gid}`, `u_status:${gid}`)]))
    );
  });

  bot.command("contact", async (ctx) => {
    const msg = ctx.message?.text || "";
    const text = msg.replace(/^\/contact(@\w+)?\s*/i, "").trim();

    if (!text) {
      await safeReply(ctx, UI.contactUsage());
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
    await safeReply(ctx, UI.contactAck());
  });
bot.action(/^u_g_view:(.+)$/i, async (ctx) => {
    const gid = String(ctx.match?.[1] || "").trim();
    await safeAnswerCb(ctx);

    await safeReply(
      ctx,
      [
        hBold("Giveaway Details"),
        "",
        `Giveaway ID: <pre>${esc(gid)}</pre>`,
        "",
        "Details + Participate button will be added in the next part.",
        "",
        fmtUtcLine(),
        footer(),
      ].join("\n")
    );
  });

  bot.action(/^u_status:(.+)$/i, async (ctx) => {
    const gid = String(ctx.match?.[1] || "").trim();
    await safeAnswerCb(ctx);

    await safeReply(
      ctx,
      [
        hBold("Status Details"),
        "",
        `Giveaway ID: <pre>${esc(gid)}</pre>`,
        "",
        "Status rendering will be added in the next part.",
        "",
        fmtUtcLine(),
        footer(),
      ].join("\n")
    );
  });

  bot.command("admin", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;

    await safeReply(
      ctx,
      [hBold("Admin Control Panel"), "", "Select a section:", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("🎁 Giveaways", "a_giveaways")],
        [Markup.button.callback("👥 Participants / Users", "a_users")],
        [Markup.button.callback("🏆 Winners & Claims", "a_winners")],
        [Markup.button.callback("📣 Messaging / Notice", "a_messaging")],
        [Markup.button.callback("📊 Statistics", "a_stats")],
        [Markup.button.callback("📂 Logs & Audit", "a_logs")],
        [Markup.button.callback("⚙️ Settings", "a_settings")],
        [Markup.button.callback("❌ Exit", "a_exit")],
      ])
    );
  });

  bot.action("a_exit", async (ctx) => {
    await safeAnswerCb(ctx);
    await safeEdit(ctx, [hBold("Panel closed."), "", fmtUtcLine()].join("\n"));
  });

  bot.action("a_back_main", async (ctx) => {
    await safeAnswerCb(ctx);
    await safeEdit(
      ctx,
      [hBold("Admin Control Panel"), "", "Select a section:", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("🎁 Giveaways", "a_giveaways")],
        [Markup.button.callback("👥 Participants / Users", "a_users")],
        [Markup.button.callback("🏆 Winners & Claims", "a_winners")],
        [Markup.button.callback("📣 Messaging / Notice", "a_messaging")],
        [Markup.button.callback("📊 Statistics", "a_stats")],
        [Markup.button.callback("📂 Logs & Audit", "a_logs")],
        [Markup.button.callback("⚙️ Settings", "a_settings")],
        [Markup.button.callback("❌ Exit", "a_exit")],
      ])
    );
  });

  bot.action("a_giveaways", async (ctx) => {
    await safeAnswerCb(ctx);
    if (!(await requireAdmin(ctx))) return;

    await safeEdit(
      ctx,
      [hBold("Giveaways"), "", "Manage giveaways.", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Create Giveaway", "a_g_create")],
        [Markup.button.callback("📋 List Giveaways", "a_g_list")],
        [Markup.button.callback("▶️ Open Giveaway", "a_g_open")],
        [Markup.button.callback("⏸ Freeze Giveaway", "a_g_freeze")],
        [Markup.button.callback("🧊 Snapshot", "a_g_snapshot")],
        [Markup.button.callback("🎯 Pick Winners", "a_g_pick")],
        [Markup.button.callback("🔒 Close Giveaway", "a_g_close")],
        [Markup.button.callback("🗑 Delete Giveaway", "a_g_delete")],
        [Markup.button.callback("⬅️ Back", "a_back_main")],
      ])
    );
  });

  bot.action("a_users", async (ctx) => {
    await safeAnswerCb(ctx);
    if (!(await requireAdmin(ctx))) return;

    await safeEdit(
      ctx,
      [hBold("Participants / Users"), "", "User tools (will be expanded).", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("🔍 Search User", "a_u_search")],
        [Markup.button.callback("✅ Valid", "a_u_valid")],
        [Markup.button.callback("⚠️ Warning", "a_u_warning")],
        [Markup.button.callback("❌ Invalid", "a_u_invalid")],
        [Markup.button.callback("🔒 Locked", "a_u_locked")],
        [Markup.button.callback("⬅️ Back", "a_back_main")],
      ])
    );
  });

  bot.action("a_winners", async (ctx) => {
    await safeAnswerCb(ctx);
    if (!(await requireAdmin(ctx))) return;

    await safeEdit(
      ctx,
      [hBold("Winners & Claims"), "", "Winner/claim tools (will be expanded).", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("🎯 View Winners", "a_w_view")],
        [Markup.button.callback("✉️ Send Claim (Bulk)", "a_w_send_bulk")],
        [Markup.button.callback("🔁 Resend Claim", "a_w_resend")],
        [Markup.button.callback("⏰ Expired Claims", "a_w_expired")],
        [Markup.button.callback("❌ Disqualify Winner", "a_w_disq")],
        [Markup.button.callback("⬅️ Back", "a_back_main")],
      ])
    );
  });
bot.action("a_messaging", async (ctx) => {
    await safeAnswerCb(ctx);
    if (!(await requireAdmin(ctx))) return;

    await safeEdit(
      ctx,
      [hBold("Messaging / Notice"), "", "Broadcast and direct messages.", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("📌 Send Notice (All Users)", "a_notice_all")],
        [Markup.button.callback("🎁 Message Participants", "a_msg_participants")],
        [Markup.button.callback("👤 Message Single User", "a_msg_user")],
        [Markup.button.callback("🔁 Resend Failed", "a_msg_resend_failed")],
        [Markup.button.callback("⬅️ Back", "a_back_main")],
      ])
    );
  });

  bot.action("a_stats", async (ctx) => {
    await safeAnswerCb(ctx);
    if (!(await requireAdmin(ctx))) return;

    await safeEdit(
      ctx,
      [
        hBold("Statistics"),
        "",
        "Statistics dashboard will be added later.",
        "",
        "• Users",
        "• Giveaways",
        "• Winners & Claims",
        "• Violations",
        "",
        fmtUtcLine(),
      ].join("\n"),
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "a_back_main")]])
    );
  });

  bot.action("a_logs", async (ctx) => {
    await safeAnswerCb(ctx);
    if (!(await requireAdmin(ctx))) return;

    await safeEdit(
      ctx,
      [hBold("Logs & Audit"), "", "Audit logs/export will be added later.", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("📁 Export Logs", "a_logs_export")],
        [Markup.button.callback("🗑 Clear Logs", "a_logs_clear")],
        [Markup.button.callback("⬅️ Back", "a_back_main")],
      ])
    );
  });

  bot.action("a_settings", async (ctx) => {
    await safeAnswerCb(ctx);
    if (!(await requireAdmin(ctx))) return;

    await safeEdit(
      ctx,
      [hBold("Settings"), "", "Global admin-only settings.", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("👤 Admin Management", "a_admins")],
        [Markup.button.callback("⬅️ Back", "a_back_main")],
      ])
    );
  });

  bot.action("a_admins", async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isOwner(ctx)) {
      await safeReply(ctx, hBold("Only owner can manage admins."));
      return;
    }

    await safeEdit(
      ctx,
      [hBold("Admin Management"), "", "Owner-only admin controls.", "", fmtUtcLine()].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Add Admin", "a_admin_add")],
        [Markup.button.callback("➖ Remove Admin", "a_admin_remove")],
        [Markup.button.callback("📋 List Admins", "a_admin_list")],
        [Markup.button.callback("⬅️ Back", "a_settings")],
      ])
    );
  });

  bot.action(/^(a_|u_).+$/i, async (ctx) => {
    await safeAnswerCb(ctx);
  });

  bot.on("message", async (ctx) => {
    if (ctx.message?.text?.startsWith("/")) {
      await ctx.reply("Unknown command.").catch(() => {});
    }
  });

  return bot;
}

/* =========================
   WEBHOOK HANDLER
========================= */

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
    console.error("WEBHOOK_ERROR", e);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
};
