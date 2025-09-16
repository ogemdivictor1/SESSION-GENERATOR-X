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
if (!ADMIN_TOKEN) {
  console.warn("⚠️ CYPHER TOKENS not set. Protected endpoints will be unprotected until you set it in Render env vars.");
}

const SESSIONS_DIR = path.join(__dirname, "sessions");
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

  let version = undefined;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
  } catch (e) {}

  const sock = makeWASocket({ auth: state, version });

  const meta = { sock, lastQR: null, sessionFolder };
  sockets.set(sessionId, meta);

  sock.ev.on("connection.update", async (update) => {
    if (update?.connection === "open") {
      try {
        await saveCreds();
        const jid = sock.user?.id;
        if (jid) {
          await sock.sendMessage(jid, {
            text: `Welcome to Cypher's WhatsApp pairing bot for session IDs. Your session ID is "${sessionId}".`
          });
        }
      } catch (e) {}
    }

    if (update?.qr) {
      meta.lastQR = update.qr;
      try { qrcodeTerminal.generate(update.qr, { small: true }); } catch (e) {}
    }
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", () => {});

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
  try {
    const dataUrl = await qrcode.toDataURL(meta.lastQR);
    res.setHeader("Content-Type", "text/html");
    return res.send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0b1220;color:#fff">
      <div style="text-align:center">
        <h2>QR for session: ${id}</h2>
        <img src="${dataUrl}" alt="QR"/>
        <p>Scan with WhatsApp</p>
      </div>
    </body></html>`);
  } catch (e) {
    return res.status(500).json({ ok: false, message: "Failed generating QR image", error: e.message });
  }
});

app.post("/api/pair-code", async (req, res) => {
  const auth = checkAdmin(req, res);
  if (!auth.ok) return res.status(401).json({ ok: false, message: auth.message });

  const id = req.body?.id || req.query?.id;
  const number = req.body?.number || req.query?.number;
  if (!id || !number) return res.status(400).json({ ok: false, message: "Missing id or number" });

  const meta = sockets.get(id);
  if (!meta) return res.status(404).json({ ok: false, message: "Session not started" });

  try {
    const baileys = await import("@whiskeysockets/baileys");
    const { generatePairingQRCode } = baileys;
    if (typeof generatePairingQRCode === "function") {
      const { qr, id: pairingId } = await generatePairingQRCode(meta.sock, number);
      return res.json({ ok: true, pairingId, message: "Pair code generated", qr });
    }
  } catch (e) {}

  return res.json({ ok: false, message: "Automatic pair-code generation not available. Open /qr/" + id + " and scan QR." });
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

  try {
    await meta.sock.logout();
    sockets.delete(id);
    return res.json({ ok: true, message: "Session stopped" });
  } catch (e) {
    return res.status(500).json({ ok: false, message: "Failed to stop session", error: e.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true, status: "Server is running" }));

app.listen(PORT, () => {
  console.log(`CYPHER PAIRS server running on http://0.0.0.0:${PORT}`);
});
