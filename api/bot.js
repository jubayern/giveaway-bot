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

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function userLink(from) {
  const id = from?.id;
  const name =
    `${from?.first_name ?? ""}${from?.last_name ? " " + from.last_name : ""}`.trim() ||
    "User";
  if (!id) return esc(name);
  return `<a href="tg://user?id=${id}">${esc(name)}</a>`;
}

function kv(obj) {
  const lines = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return `<pre>${esc(lines.join("\n"))}</pre>`;
}

function box(title, bodyHtml) {
  return `<b>${esc(title)}</b>\n\n${bodyHtml}`;
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
      await sendToChat(
        ctx,
        START_LOG_CHANNEL_ID,
        box(
          "New User Started",
          `${kv({
            user_id: `${ctx.from?.id ?? "unknown"}`,
            username: ctx.from?.username ? "@" + ctx.from.username : "no_username",
            utc: nowUtcIso(),
          })}\n${userLink(ctx.from)}`
        ),
        { parse_mode: "HTML", disable_web_page_preview: true }
      );
    }

    await ctx.reply(
      "Welcome.\n\n1) Join the required channels\n2) Tap “Verify & Participate”\n\nNeed help? Use /contact."
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
      await ctx.reply("Usage:\n/contact your message");
      return;
    }

    await sendToChat(
      ctx,
      SUPPORT_CHANNEL_ID,
      box(
        "Support Message",
        `${kv({
          user_id: `${ctx.from?.id ?? "unknown"}`,
          username: ctx.from?.username ? "@" + ctx.from.username : "no_username",
          utc: nowUtcIso(),
        })}\n<b>Message</b>\n<blockquote>${esc(text)}</blockquote>\n\n${userLink(ctx.from)}`
      ),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );

    await ctx.reply("Thanks. Your message has been sent to support.");
  });

  bot.command("whoami", async (ctx) => {
    const uid = ctx.from?.id;
    const role = uid && isAdminId(uid) ? "ADMIN" : "USER";
    await ctx.reply(
      `You are:\nID: ${ctx.from?.id ?? "unknown"}\nUsername: ${
        ctx.from?.username ? "@" + ctx.from.username : "no_username"
      }\nUTC: ${nowUtcIso()}\nRole: ${role}`
    );
  });

  bot.command("admin", requireAdmin, async (ctx) => {
    await ctx.reply(
      "Admin Panel\n\nCommands:\n/admin\n/admin_stats\n/admin_broadcast <text>\n\nNote: Giveaway commands will be added next."
    );
  });

  bot.command("admin_stats", requireAdmin, async (ctx) => {
    await ctx.reply(
      box(
        "Admin Stats",
        `${kv({
          utc: nowUtcIso(),
          admins: ADMIN_IDS.join(", "),
          admin_panel_chat_id: `${ADMIN_PANEL_CHAT_ID}`,
          start_log_channel_id: `${START_LOG_CHANNEL_ID}`,
          support_channel_id: `${SUPPORT_CHANNEL_ID}`,
        })}`
      ),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  });

  bot.command("admin_broadcast", requireAdmin, async (ctx) => {
    const msg = ctx.message?.text || "";
    const text = msg.replace(/^\/admin_broadcast(@\w+)?\s*/i, "").trim();

    if (!text) {
      await ctx.reply("Usage: /admin_broadcast <text>");
      return;
    }

    const ok = await sendToChat(
      ctx,
      ADMIN_PANEL_CHAT_ID,
      box(
        "Admin Broadcast",
        `${kv({
          utc: nowUtcIso(),
          from_admin_id: `${ctx.from?.id ?? "unknown"}`,
        })}\n<blockquote>${esc(text)}</blockquote>`
      ),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );

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
