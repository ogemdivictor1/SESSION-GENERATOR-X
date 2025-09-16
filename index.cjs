const express = require("express");
const fs = require("fs");
const path = require("path");
const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const SESSIONS_DIR = path.join(process.cwd(), "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const activeSessions = {};

async function initSession(number) {
  const sessionPath = path.join(SESSIONS_DIR, number);
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    console.log(`[${number}] Session folder created at ${sessionPath}`);
  } else {
    console.log(`[${number}] Session folder already exists.`);
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    version: await fetchLatestBaileysVersion(),
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);
  activeSessions[number] = sock;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    console.log(`[${number}] Connection update:`, connection);

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${number}] Connection closed. Reason:`, reason);
    }

    if (connection === "open") {
      console.log(`[${number}] WhatsApp session is now active.`);
      try {
        await sock.sendMessage(`${number}@s.whatsapp.net`, {
          text: `✅ Your Cypher session is active.\nSession ID: ${number}`
        });
      } catch (err) {
        console.error(`[${number}] Failed to send WhatsApp message:`, err);
      }
    }

    if (qr) {
      console.log(`[${number}] QR code generated.`);
    }
  });

  return sock;
}

app.post("/api/pair", async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ ok: false, message: "Phone number missing" });

  try {
    const sock = activeSessions[number] || await initSession(number);
    return res.json({ ok: true, session: number });
  } catch (err) {
    console.error(`[${number}] Pair error:`, err);
    return res.status(500).json({ ok: false, message: "Failed to generate session" });
  }
});

app.get("/api/qr", async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).json({ ok: false, message: "Phone number missing" });

  try {
    const sock = activeSessions[number] || await initSession(number);
    let qr = null;

    sock.ev.on("connection.update", ({ qr: newQR }) => {
      if (newQR) qr = newQR;
    });

    setTimeout(() => {
      if (qr) {
        console.log(`[${number}] QR ready for delivery.`);
        res.json({ ok: true, qr: `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300` });
      } else {
        console.warn(`[${number}] QR not available after timeout.`);
        res.json({ ok: false, message: "QR not available" });
      }
    }, 1500);
  } catch (err) {
    console.error(`[${number}] QR error:`, err);
    res.status(500).json({ ok: false, message: "Failed to load QR" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Cypher bot running on port ${PORT}`));
