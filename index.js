// ==================== Importações ====================
import express from "express";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import fetch from "node-fetch";
import fs from "fs";

// ==================== Configuração ====================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

// URL do Webhook da IRIS
const WEBHOOK_URL = "https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook";

let sock;

// ==================== Função principal ====================
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  });

  // Salva credenciais
  sock.ev.on("creds.update", saveCreds);

  // Atualização de conexão
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("🔄 Escaneie este QR Code para conectar ao WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
    } else if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("⚠️ Conexão encerrada. Reconnecting:", shouldReconnect);
      if (shouldReconnect) startSock();
    }
  });

  // ==================== NOVO BLOCO IMPORTANTE ====================
  // Envia mensagens recebidas para o webhook da IRIS
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return; // Ignora mensagens enviadas por você

    const de = msg.key.remoteJid;
    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      "";
    const nome = msg.pushName || "Cliente";

    const payload = {
      de,
      mensagem: texto,
      nome,
      timestamp: Date.now(),
    };

    console.log("📩 Mensagem recebida:", payload);

    try {
      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        console.log("📨 Mensagem encaminhada ao webhook IRIS com sucesso!");
      } else {
        console.error("⚠️ Erro ao enviar webhook IRIS:", await response.text());
      }
    } catch (error) {
      console.error("❌ Erro ao enviar para o webhook:", error);
    }
  });

  return sock;
}

// ==================== Inicializa conexão ====================
startSock();

// ==================== ENDPOINTS ====================

// ---------- STATUS ----------
app.get("/status", (req, res) => {
  const isConnected = sock?.user ? true : false;
  const number = sock?.user?.id ? sock.user.id.split(":")[0] : null;

  res.json({
    status: "online",
    mensagem: "Servidor rodando e pronto para integração com Lovable!",
    conectado: isConnected,
    number,
  });
});

// ---------- ENVIO DE MENSAGEM ----------
app.post("/send", async (req, res) => {
  try {
    const to = req.body.to || req.body.number || req.body.telefone;
    const text = req.body.text || req.body.message || req.body.mensagem;

    if (!to || !text) {
      return res.status(400).json({
        status: "error",
        message:
          "Campos inválidos. Envie { to/text } ou { number/message } no corpo da requisição.",
      });
    }

    const cleanNumber = to.replace(/\D/g, "");
    const jid = cleanNumber.includes("@s.whatsapp.net")
      ? cleanNumber
      : `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text });
    console.log("📤 Mensagem enviada com sucesso para:", jid);

    res.json({ status: "ok", para: jid, mensagem: text });
  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ---------- LOGOUT ----------
app.get("/logout", async (req, res) => {
  try {
    await sock.logout();
    res.json({ status: "ok", message: "Sessão encerrada com sucesso." });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
