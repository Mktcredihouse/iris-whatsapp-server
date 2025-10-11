// index.js – ESM
import express from "express";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
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
const WEBHOOK_URL = "https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook"; // 👈 webhook Lovable

const log = pino({ level: "info" });

// cache do QR p/ a rota /qr
let lastQRString = null;
let lastQRPng = null;
let qrUpdatedAt = 0;
let isConnected = false;

const app = express();
app.use(express.json());

/* -------------------------- Rotas HTTP -------------------------- */

app.get("/qr", async (req, res) => {
  if (isConnected) {
    return res.send(
      `<h1>Já conectado ✅</h1><p>Se precisar gerar um novo QR, faça logout em /logout.</p>`
    );
  }
  if (lastQRPng) {
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    });
    res.end(lastQRPng);
  } else {
    res.send("QR code ainda não disponível.");
  }
});

app.get("/logout", async (req, res) => {
  try {
    await fs.rm(SESSION_DIR, { recursive: true, force: true });
    res.send("Sessão encerrada. Reinicie o servidor para gerar novo QR.");
    process.exit(0);
  } catch (err) {
    console.error("Erro ao fazer logout:", err);
    res.status(500).send("Erro ao fazer logout.");
  }
});

app.post("/send", async (req, res) => {
  const { to, message } = req.body;
  if (!sock || !to || !message) {
    return res.status(400).send({ error: "Parâmetros inválidos." });
  }
  try {
    await sock.sendMessage(to, { text: message });
    res.send({ success: true });
  } catch (error) {
    console.error("Erro ao enviar mensagem:", error);
    res.status(500).send({ error: "Erro ao enviar mensagem." });
  }
});

/* -------------------------- Socket Baileys -------------------------- */

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, log),
    },
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQRString = qr;
      QRCode.toBuffer(qr).then((png) => {
        lastQRPng = png;
        qrUpdatedAt = Date.now();
      });
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
      isConnected = true;
    } else if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("Conexão fechada:", reason);
      isConnected = false;
      setTimeout(startSock, 5000);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // 🚀 Envio de Webhooks Lovable
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const payload = {
      de: msg.key.remoteJid,
      mensagem:
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "",
      nome: msg.pushName || "Contato desconhecido",
    };

    try {
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log("📡 Webhook enviado para Lovable:", payload);
    } catch (error) {
      console.error("Erro ao enviar webhook:", error);
    }
  });

  return sock;
}

let sock;
startSock();

/* -------------------------- Inicialização -------------------------- */

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
