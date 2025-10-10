// index.js

import express from "express";
import cors from "cors";
import { createServer } from "http";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const AUTH_FOLDER = "./auth_info";

// 🔹 Função principal de inicialização do WhatsApp
async function startWhatsApp() {
  // Garante que a pasta de autenticação exista
  if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER);
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // exibe QR no log da Render
    browser: ["Ubuntu", "Chrome", "22.04"],
  });

  // Salva credenciais ao atualizar
  sock.ev.on("creds.update", saveCreds);

  // Escuta eventos de conexão
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("❌ Conexão encerrada. Reconectar:", shouldReconnect);
      if (shouldReconnect) startWhatsApp();
    } else if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp com sucesso!");
    }

    if (update.qr) {
      console.log("📱 Escaneie este QR Code para conectar:");
    }
  });

  // Recebendo mensagens
  sock.ev.on("messages.upsert", async (msg) => {
    console.log("📨 Mensagem recebida:", JSON.stringify(msg, null, 2));

    const message = msg.messages[0];
    if (!message.key.fromMe && message.message?.conversation) {
      const from = message.key.remoteJid;
      const text = message.message.conversation;

      console.log(`👤 ${from} disse: ${text}`);

      // Você pode responder automaticamente aqui, se quiser:
      // await sock.sendMessage(from, { text: "Recebi sua mensagem ✅" });

      // OU enviar para o webhook Lovable
      await sendToWebhook({ from, text });
    }
  });

  // Função para enviar mensagens via API
  app.post("/send", async (req, res) => {
    const { number, message } = req.body;

    if (!number || !message) {
      return res.status(400).json({ error: "Número e mensagem são obrigatórios" });
    }

    try {
      await sock.sendMessage(`${number}@s.whatsapp.net`, { text: message });
      res.json({ success: true });
    } catch (error) {
      console.error("Erro ao enviar mensagem:", error);
      res.status(500).json({ error: "Falha ao enviar mensagem" });
    }
  });

  console.log("🌐 Servidor WhatsApp inicializado");
}

// 🔹 Webhook para receber mensagens da Lovable (Supabase)
app.post("/webhook", async (req, res) => {
  console.log("🌍 Webhook Lovable recebido:", req.body);
  // Aqui você pode tratar os dados vindos da Lovable para enviar mensagens via Baileys
  res.sendStatus(200);
});

// 🔸 Função para repassar mensagens recebidas para o webhook Lovable
async function sendToWebhook(data) {
  const webhookURL = "https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook";

  try {
    const response = await fetch(webhookURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    console.log(`📡 Enviado para webhook (${response.status})`);
  } catch (error) {
    console.error("Erro ao enviar para webhook:", error);
  }
}

// 🟢 Endpoint raiz
app.get("/", (req, res) => {
  res.send("✅ Servidor WhatsApp ativo e rodando!");
});

// Inicia servidor HTTP
createServer(app).listen(PORT, () => {
  console.log(`🚀 Servidor HTTP rodando na porta ${PORT}`);
});

// Inicializa Baileys
startWhatsApp();
