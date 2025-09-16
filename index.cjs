require("dotenv").config();
const path = require("path");
const fs = require("fs-extra");
const express = require("express");
const qrcode = require("qrcode");
const cookieParser = require("cookie-parser");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env["CYPHER_TOKENS"] || "";
const CUSTOM_PAIR_CODE = process.env.CUSTOM_PAIR_CODE || "CYPHER-2025";
const SESSION_ID = process.env.SESSION_ID || "cypher";
const SESSIONS_DIR = path.join(__dirname, "sessions");

fs.ensureDirSync(SESSIONS_DIR);
const sockets = new Map();

async function createSession(sessionId) {
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
    if (update?.qr) {
      meta.lastQR = update.qr;
    }
    if (update?.connection === "open") {
      await saveCreds();
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return meta;
}

// Auto-start session on boot
createSession(SESSION_ID);

function checkAuth(req, res) {
  const token = req.cookies?.admin || req.query?.token || req.headers["x-admin-token"];
  if (!ADMIN_TOKEN || token === ADMIN_TOKEN) return true;
  res.status(403).send("Unauthorized");
  return false;
}

app.get("/qr.html", async (req, res, next) => checkAuth(req, res) && next());
app.get("/pair.html", async (req, res, next) => checkAuth(req, res) && next());
app.get("/dashboard.html", async (req, res, next) => checkAuth(req, res) && next());

app.get("/api/qr", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const meta = sockets.get(SESSION_ID);
  if (!meta?.lastQR) return res.status(404).send("QR not available");
  const dataUrl = await qrcode.toDataURL(meta.lastQR);
  res.json({ ok: true, qr: dataUrl });
});

app.post("/api/pair", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const number = req.body?.number || req.query?.number;
  if (!number) return res.status(400).json({ ok: false, message: "Missing phone number" });

  const meta = sockets.get(SESSION_ID);
  if (!meta) return res.status(500).json({ ok: false, message: "Session not ready" });

  try {
    const { generatePairingCode } = await import("@whiskeysockets/baileys");
    const result = await generatePairingCode(meta.sock, CUSTOM_PAIR_CODE, number);
    res.json({ ok: true, code: CUSTOM_PAIR_CODE, number, result });
  } catch (e) {
    res.json({ ok: false, message: "Pair code generation failed" });
  }
});

app.post("/api/login", (req, res) => {
  const token = req.body?.token;
  if (token === ADMIN_TOKEN) {
    res.cookie("admin", token, { httpOnly: true });
    res.json({ ok: true });
  } else {
    res.status(403).json({ ok: false, message: "Invalid token" });
  }
});

app.listen(PORT, () => {
  console.log(`CYPHER server running on http://0.0.0.0:${PORT}`);
});
