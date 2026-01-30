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
   REDIS KEYS (PART-1)
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
          "Details will appear here in the next part.",
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
        ...Markup.inlineKeyboard(
          gids.map((gid) => [Markup.button.callback(`${gid}`, `u_g_view:${gid}`)])
        ),
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
      [
        hBold("Select a Giveaway to View Status"),
        "",
        fmtUtcLine(),
        footer(),
      ].join("\n"),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(
          gids.map((gid) => [Markup.button.callback(`${gid}`, `u_status:${gid}`)])
        ),
      }
    );
  });

  bot.command("contact", async (ctx) => {
    const C = cfg();
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
        "Details + Participate button will be added in the next part.",
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
        "Status rendering will be added in the next part.",
        "",
        fmtUtcLine(),
        footer(),
      ].join("\n"),
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
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
};
