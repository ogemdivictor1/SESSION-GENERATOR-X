require("dotenv").config();
const path = require("path");
const fs = require("fs-extra");
const express = require("express");
const qrcode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const cookieParser = require("cookie-parser");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env["CYPHER TOKENS"] || "";
const CUSTOM_PAIR_CODE = process.env.CUSTOM_PAIR_CODE || "CYPHER-2025";
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, "sessions");

fs.ensureDirSync(SESSIONS_DIR);
const sockets = new Map();

function checkAdmin(req, res) {
  const token = (req.query.token || req.headers["x-admin-token"] || "").toString();
  if (!ADMIN_TOKEN) return { ok: true };
  if (token && token === ADMIN_TOKEN) return { ok: true };
  return { ok: false, message: "Missing or invalid admin token" };
}

async function createSession(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  if (sockets.has(sessionId)) return sockets.get(sessionId);

  const baileys = await import("@whiskeysockets/baileys");
  const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;

  const sessionFolder = path.join(SESSIONS_DIR, sessionId);
  await fs.ensureDir(sessionFolder);

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const version = (await fetchLatestBaileysVersion()).version;

  const sock = makeWASocket({ auth: state, version });
  const meta = { sock, lastQR: null, sessionFolder };
  sockets.set(sessionId, meta);

  sock.ev.on("connection.update", async (update) => {
    if (update?.connection === "open") {
      await saveCreds();
      const jid = sock.user?.id;
      if (jid) {
        await sock.sendMessage(jid, {
          text: `Welcome to Cypher's WhatsApp pairing bot. Your session ID is "${sessionId}".`
        });
      }
    }
    if (update?.qr) {
      meta.lastQR = update.qr;
      qrcodeTerminal.generate(update.qr, { small: true });
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return meta;
}

app.post("/api/start-session", async (req, res) => {
  const auth = checkAdmin(req, res);
  if (!auth.ok) return res.status(401).json({ ok: false, message: auth.message });

  const id = req.body?.id || req.query?.id;
  if (!id) return res.status(400).json({ ok: false, message: "Missing session id" });

  try {
    const meta = await createSession(id);
    return res.json({ ok: true, id, inMemory: true, hasCreds: await fs.pathExists(path.join(meta.sessionFolder, "creds.json")) });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.get("/qr/:id", async (req, res) => {
  const id = req.params.id;
  const meta = sockets.get(id);
  if (!meta || !meta.lastQR) return res.status(404).send("No QR available for this session.");
  const dataUrl = await qrcode.toDataURL(meta.lastQR);
  res.send(`<html><body style="background:#0b1220;color:#fff;text-align:center;padding-top:50px">
    <h2>QR for session: ${id}</h2>
    <img src="${dataUrl}" alt="QR"/>
    <p>Scan with WhatsApp</p>
  </body></html>`);
});

app.post("/api/pair-code", async (req, res) => {
  const auth = checkAdmin(req, res);
  if (!auth.ok) return res.status(401).json({ ok: false, message: auth.message });

  const id = req.body?.id || req.query?.id;
  const number = req.body?.number || req.query?.number;
  if (!id || !number) return res.status(400).json({ ok: false, message: "Missing session id or phone number" });

  const meta = sockets.get(id);
  if (!meta) return res.status(404).json({ ok: false, message: "Session not started" });

  try {
    const { generatePairingCode } = await import("@whiskeysockets/baileys");
    const result = await generatePairingCode(meta.sock, CUSTOM_PAIR_CODE, number);
    return res.json({ ok: true, code: CUSTOM_PAIR_CODE, number, message: "Custom pair code generated", result });
  } catch (e) {
    return res.json({ ok: false, message: "Pair-code generation failed or unsupported in this build." });
  }
});

app.get("/api/status/:id", async (req, res) => {
  const id = req.params.id;
  const meta = sockets.get(id);
  const folder = path.join(SESSIONS_DIR, id);
  const hasCreds = await fs.pathExists(path.join(folder, "creds.json"));
  return res.json({ ok: true, id, inMemory: !!meta, hasCreds });
});

app.post("/api/stop-session", async (req, res) => {
  const auth = checkAdmin(req, res);
  if (!auth.ok) return res.status(401).json({ ok: false, message: auth.message });

  const id = req.body?.id || req.query?.id;
  const meta = sockets.get(id);
  if (!meta) return res.status(404).json({ ok: false, message: "Session not found" });

  await meta.sock.logout();
  sockets.delete(id);
  return res.json({ ok: true, message: "Session stopped" });
});

app.get("/health", (req, res) => res.json({ ok: true, status: "Server is running" }));

app.listen(PORT, () => {
  console.log(`CYPHER PAIRS server running on http://0.0.0.0:${PORT}`);
});
