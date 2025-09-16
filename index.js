const express = require("express");
const fs = require("fs");
const path = require("path");
const cookieParser = require("cookie-parser");
const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] || "";
const CUSTOM_PAIR_CODE = process.env["CUSTOM_PAIR_CODE"] || "CYPHER-2025";
const SESSIONS_DIR = "/sessions"; // Use persistent disk path on Render

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const activeSessions = {};

async function initSession(number) {
  const sessionPath = path.join(SESSIONS_DIR, number);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const sock = makeWASocket({ auth: state });
  sock.ev.on("creds.update", saveCreds);
  activeSessions[number] = sock;
  return sock;
}

app.post("/api/pair", async (req, res) => {
  const { number } = req.body;
  const token = req.cookies.token;
  if (token !== ADMIN_TOKEN) return res.status(403).json({ ok: false, message: "Unauthorized" });

  try {
    const sock = activeSessions[number] || await initSession(number);
    await sock.sendMessage(`${number}@s.whatsapp.net`, {
      text: `✅ Your Cypher session is active.\nSession ID: ${number}\nPair Code: ${CUSTOM_PAIR_CODE}`
    });
    return res.json({ ok: true, number, code: CUSTOM_PAIR_CODE });
  } catch (err) {
    return res.status(500).json({ ok: false, message: "Failed to generate pair code" });
  }
});

app.get("/api/qr", async (req, res) => {
  const { number } = req.query;
  const token = req.cookies.token;
  if (token !== ADMIN_TOKEN) return res.status(403).json({ ok: false, message: "Unauthorized" });

  try {
    const sock = activeSessions[number] || await initSession(number);
    let qr = null;
    sock.ev.on("connection.update", ({ qr: newQR }) => {
      if (newQR) qr = newQR;
    });

    setTimeout(() => {
      if (qr) {
        res.json({ ok: true, qr: `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300` });
      } else {
        res.json({ ok: false, message: "QR not available" });
      }
    }, 1500);
  } catch (err) {
    res.status(500).json({ ok: false, message: "Failed to load QR" });
  }
});

app.post("/api/login", (req, res) => {
  const { token } = req.body;
  if (token === ADMIN_TOKEN) {
    res.cookie("token", token, { httpOnly: true });
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, message: "Invalid token" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Cypher bot running on port ${PORT}`));
