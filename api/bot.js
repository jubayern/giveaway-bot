const { Telegraf } = require("telegraf");

let bot;

function getBot() {
  if (bot) return bot;

  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("Missing BOT_TOKEN");

  bot = new Telegraf(token);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome. Please join the required channels and tap “Verify & Participate”.\n\nIf you need help, use /contact."
    );
  });

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  bot.command("contact", async (ctx) => {
    await ctx.reply("Please type your message after /contact (free text).");
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
