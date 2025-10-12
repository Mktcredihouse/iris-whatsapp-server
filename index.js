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
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;

let sock;

// ==================== Função principal ====================
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  });

  // Salva credenciais ao atualizar
  sock.ev.on("creds.update", saveCreds);

  // Atualizações de conexão
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

  // Recebe mensagens novas
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const payload = {
      de: msg.key.remoteJid,
      mensagem:
        msg.message.conversation || msg.message.extendedTextMessage?.text || "",
      nome: msg.pushName || "Contato desconhecido",
    };

    if (WEBHOOK_URL) {
      try {
        await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        console.log("📩 Webhook enviado para Lovable:", payload);
      } catch (err) {
        console.error("❌ Erro ao enviar webhook:", err);
      }
    }
  });

  return sock;
}

// ==================== Inicializa Conexão ====================
startSock();

// ==================== ENDPOINTS ====================

// ---------- Status ----------
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

// ---------- Envio de Mensagens ----------
app.post("/send", async (req, res) => {
  try {
    // Aceita formatos variados do Lovable
    const to = req.body.to || req.body.number || req.body.telefone;
    const text = req.body.text || req.body.message || req.body.mensagem;

    if (!to || !text) {
      return res.status(400).json({
        status: "error",
        message:
          "Campos inválidos. Envie { to/text } ou { number/message } no corpo da requisição.",
      });
    }

    // Limpa o número (remove tudo que não for dígito)
    const cleanNumber = to.replace(/\D/g, "");

    // Adiciona o sufixo do WhatsApp se necessário
    const jid = cleanNumber.includes("@s.whatsapp.net")
      ? cleanNumber
      : `${cleanNumber}@s.whatsapp.net`;

    // Envia a mensagem
    await sock.sendMessage(jid, { text });
    console.log("📤 Mensagem enviada com sucesso para:", jid);

    res.json({
      status: "ok",
      para: jid,
      mensagem: text,
    });
  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error);
    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// ---------- Logout Manual ----------
app.get("/logout", async (req, res) => {
  try {
    await sock.logout();
    res.json({ status: "ok", message: "Sessão encerrada com sucesso." });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ---------- Inicialização ----------
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
