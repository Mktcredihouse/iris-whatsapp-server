// index.js — ESM
import express from "express";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const SESSION_ID = process.env.SESSION_ID || "iris-session";
const SESSION_DIR = path.join(process.cwd(), SESSION_ID);

const WEBHOOK_URL = process.env.WEBHOOK_URL || "";   // opcional
const API_TOKEN = process.env.API_TOKEN || "";       // protege /send (opcional)

const log = pino({ level: "info" });

// cache do QR p/ a rota /qr
let lastQRString = null;
let lastQRPng = null;
let qrUpdatedAt = 0;
let isConnected = false;

const app = express();
app.use(express.json());

/* ---------------------- Rotas HTTP ----------------------- */

// saúde
app.get("/", (_req, res) => {
  res.send(
    `<h1>Baileys WhatsApp Server</h1>
     <p>Status: <b>${isConnected ? "conectado ✅" : "aguardando conexão..."}</b></p>
     <p>QR: <a href="/qr" target="_blank">/qr</a></p>
     <p>Status JSON: <a href="/status" target="_blank">/status</a></p>`
  );
});

// página HTML do QR (auto-refresh enquanto não conecta)
app.get("/qr", (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (isConnected) {
    return res.send(
      "<h2>Já conectado ✅</h2><p>Se precisar gerar um novo QR, faça logout em /logout.</p>"
    );
  }

  const bust = Date.now();
  res.send(`<!doctype html>
<html lang="pt-br"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>QR • WhatsApp</title>
<style>
  body{font-family:system-ui,Arial;margin:32px;background:#0b0b0f;color:#eaeaea}
  .card{max-width:380px;margin:auto;background:#151821;border-radius:16px;padding:24px;box-shadow:0 10px 35px rgba(0,0,0,.35)}
  h1{font-size:18px;margin:0 0 12px 0}
  img{width:100%;height:auto;border-radius:10px;background:#fff}
  .muted{opacity:.7;font-size:13px}
  .row{display:flex;justify-content:space-between;align-items:center;margin-top:12px}
  button{background:#2463eb;border:0;color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer}
</style>
</head><body>
<div class="card">
  <h1>Escaneie para conectar</h1>
  <img alt="QR" src="/qr.png?bust=${bust}" onerror="this.src='/qr.png?bust='+(Date.now())" />
  <div class="row">
    <span class="muted">Atualiza a cada 3s • ${new Date(qrUpdatedAt).toLocaleTimeString()}</span>
    <button onclick="location.reload()">Atualizar</button>
  </div>
</div>
<script>
  setInterval(()=>location.reload(), 3000);
</script>
</body></html>`);
});

// a imagem PNG do QR
app.get("/qr.png", (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!lastQRPng) {
    return res
      .status(404)
      .send("QR ainda não gerado. Aguarde alguns segundos e atualize.");
  }
  res.type("png").send(lastQRPng);
});

// status JSON
app.get("/status", (_req, res) => {
  res.json({
    connected: isConnected,
    lastQRAt: qrUpdatedAt || null,
    session: SESSION_ID,
  });
});

// envio de mensagem via HTTP (para a Lovable/sua UI)
// body: { "to": "5511999999999", "message": "Olá" }
let sock; // definido depois
app.post("/send", async (req, res) => {
  try {
    if (API_TOKEN) {
      const auth = req.headers.authorization || "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (token !== API_TOKEN) return res.status(401).json({ error: "unauthorized" });
    }

    const { to, message } = req.body || {};
    if (!to || !message) return res.status(400).json({ error: "to e message são obrigatórios" });

    const jid = to.replace(/\D/g, "") + "@s.whatsapp.net";
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (e) {
    log.error(e);
    res.status(500).json({ error: "send failed" });
  }
});

// apaga a sessão e reinicia o processo (gera novo QR)
app.post("/logout", async (_req, res) => {
  try {
    await fs.rm(SESSION_DIR, { recursive: true, force: true });
    res.json({ ok: true, msg: "sessão removida, reiniciando..." });
    setTimeout(() => process.exit(0), 200); // Render vai subir de novo
  } catch (e) {
    log.error(e);
    res.status(500).json({ error: "logout failed" });
  }
});

/* ------------------ Baileys / WhatsApp ------------------- */

async function startWhatsApp() {
  const logger = pino({ level: "fatal" }); // baileys quieto
  const { version } = await fetchLatestBaileysVersion();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // gerenciamos nós mesmos
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ["Ubuntu", "Chrome", "22.04"],
  });

  sock.ev.process(async (events) => {
    if (events["creds.update"]) await saveCreds();

    if (events["connection.update"]) {
      const { connection, lastDisconnect, qr } = events["connection.update"];

      // chegou um QR -> gerar PNG pro /qr
      if (qr) {
        lastQRString = qr;
        lastQRPng = await QRCode.toBuffer(qr, { width: 420, margin: 1 });
        qrUpdatedAt = Date.now();
        isConnected = false;
        log.info("Novo QR disponível.");
      }

      if (connection === "open") {
        isConnected = true;
        lastQRString = null;
        lastQRPng = null;
        log.info("Conectado ao WhatsApp ✅");
      }

      if (connection === "close") {
        isConnected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const mustRelog = code === DisconnectReason.loggedOut;
        log.warn({ code }, "Conexão fechada");

        if (mustRelog) {
          // sessão inválida -> limpar e reiniciar
          await fs.rm(SESSION_DIR, { recursive: true, force: true });
          setTimeout(() => process.exit(0), 300);
          return;
        }
        // reconectar
        setTimeout(startWhatsApp, 2000);
      }
    }

    // exemplo: log de mensagens recebidas
    if (events["messages.upsert"]) {
      const up = events["messages.upsert"];
      for (const msg of up.messages || []) {
        const from = msg.key?.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
        if (from && text) {
          log.info({ from, text }, "Mensagem recebida");
          // se quiser disparar webhook:
          if (WEBHOOK_URL) {
            fetch(WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ remoteJid: from, message: text, timestamp: Date.now() }),
            }).catch(() => {});
          }
        }
      }
    }
  });
}

app.listen(PORT, () => {
  log.info(`HTTP na porta ${PORT}`);
  startWhatsApp().catch((e) => {
    log.error(e, "Falha ao iniciar WhatsApp");
  });
});
