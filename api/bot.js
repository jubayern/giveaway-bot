const { Telegraf } = require("telegraf");

let bot;

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function parseIdList(str) {
  return String(str || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

function nowUtcIso() {
  return new Date().toISOString();
}

function isPrivateChat(ctx) {
  return ctx.chat && ctx.chat.type === "private";
}

function safeUserLine(from) {
  const id = from?.id ?? "unknown";
  const fn = from?.first_name ?? "";
  const ln = from?.last_name ?? "";
  const name = `${fn}${ln ? " " + ln : ""}`.trim();
  const uname = from?.username ? `@${from.username}` : "no_username";
  return `id=${id} | ${name || "no_name"} | ${uname}`;
}

async function sendToChat(ctx, chatId, text, extra) {
  try {
    await ctx.telegram.sendMessage(chatId, text, extra || {});
    return true;
  } catch (_) {
    return false;
  }
}

function getBot() {
  if (bot) return bot;

  const token = mustEnv("BOT_TOKEN");

  const ADMIN_IDS = parseIdList(mustEnv("ADMIN_IDS"));
  const ADMIN_PANEL_CHAT_ID = Number(mustEnv("ADMIN_PANEL_CHAT_ID"));
  const START_LOG_CHANNEL_ID = Number(mustEnv("START_LOG_CHANNEL_ID"));
  const SUPPORT_CHANNEL_ID = Number(mustEnv("SUPPORT_CHANNEL_ID"));

  bot = new Telegraf(token);

  const isAdminId = (id) => ADMIN_IDS.includes(Number(id));

  const requireAdmin = async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid || !isAdminId(uid)) {
      await ctx.reply("Access denied.");
      return;
    }
    return next();
  };

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  bot.command("start", async (ctx) => {
    if (isPrivateChat(ctx)) {
      const uline = safeUserLine(ctx.from);
      const t = nowUtcIso();
      await sendToChat(
        ctx,
        START_LOG_CHANNEL_ID,
        `NEW USER START\n${uline}\nUTC: ${t}`
      );
    }

    await ctx.reply(
      "Welcome. Please join the required channels and tap “Verify & Participate”.\n\nIf you need help, use /contact."
    );
  });

  bot.command("contact", async (ctx) => {
    if (!isPrivateChat(ctx)) {
      await ctx.reply("Please use /contact in a private chat with the bot.");
      return;
    }

    const msg = ctx.message?.text || "";
    const text = msg.replace(/^\/contact(@\w+)?\s*/i, "").trim();

    if (!text) {
      await ctx.reply("Please type your message after /contact (free text).");
      return;
    }

    const uline = safeUserLine(ctx.from);
    const t = nowUtcIso();

    await sendToChat(
      ctx,
      SUPPORT_CHANNEL_ID,
      `CONTACT MESSAGE\n${uline}\nUTC: ${t}\n\n${text}`
    );

    await ctx.reply("Thanks. Your message has been sent to support.");
  });

  bot.command("whoami", async (ctx) => {
    const uid = ctx.from?.id;
    const uline = safeUserLine(ctx.from);
    await ctx.reply(
      `You are:\n${uline}\nUTC: ${nowUtcIso()}\nRole: ${uid && isAdminId(uid) ? "ADMIN" : "USER"}`
    );
  });

  bot.command("admin", requireAdmin, async (ctx) => {
    await ctx.reply(
      "Admin Panel\n\nCommands:\n/admin\n/admin_stats\n/admin_broadcast <text>\n\nNote: giveaway commands will be added in the next phase."
    );
  });

  bot.command("admin_stats", requireAdmin, async (ctx) => {
    await ctx.reply(
      `Admin Stats\nUTC: ${nowUtcIso()}\nAdmins: ${ADMIN_IDS.join(", ")}\nAdminPanelChatId: ${ADMIN_PANEL_CHAT_ID}`
    );
  });

  bot.command("admin_broadcast", requireAdmin, async (ctx) => {
    const msg = ctx.message?.text || "";
    const text = msg.replace(/^\/admin_broadcast(@\w+)?\s*/i, "").trim();

    if (!text) {
      await ctx.reply("Usage: /admin_broadcast <text>");
      return;
    }

    const ok = await sendToChat(ctx, ADMIN_PANEL_CHAT_ID, `BROADCAST\nUTC: ${nowUtcIso()}\n\n${text}`);
    await ctx.reply(ok ? "Broadcast sent to admin panel." : "Failed to send broadcast.");
  });

  bot.on("message", async (ctx, next) => {
    const msgText = ctx.message?.text || "";
    if (msgText.startsWith("/admin") && !isAdminId(ctx.from?.id)) {
      await ctx.reply("Access denied.");
      return;
    }
    return next();
  });

  return bot;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
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
    res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
  }
};
