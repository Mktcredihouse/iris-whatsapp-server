import express from "express";
import fetch from "node-fetch";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const WEBHOOK_URL = "https://lovable.run/api/webhook"; // altere se tiver outro

let sock; // 🔹 variável global

// ==================== FUNÇÃO DE CONEXÃO ====================
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  sock = makeWASocket({
    printQRInTerminal: true,
    auth: state
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📲 Escaneie o QR Code abaixo para conectar:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
      global.sock = sock; // 🔥 Define como global (fundamental!)
    } else if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log("⚠️ Conexão encerrada. Tentando reconectar:", shouldReconnect);
      if (shouldReconnect) startSock();
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const payload = {
      de: msg.key.remoteJid,
      mensagem:
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "",
      nome: msg.pushName || "Contato desconhecido"
    };

    try {
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      console.log("📩 Webhook enviado para Lovable:", payload);
    } catch (error) {
      console.error("❌ Erro ao enviar webhook:", error);
    }
  });

  return sock;
}

// ==================== ENDPOINTS ====================

// Enviar mensagem manualmente
app.post("/send", async (req, res) => {
  const { number, message } = req.body;
  try {
    await sock.sendMessage(`${number}@s.whatsapp.net`, { text: message });
    res.json({ status: "ok", number, message });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Encerrar sessão manualmente
app.get("/logout", async (req, res) => {
  try {
    await sock.logout();
    res.json({ status: "ok", message: "Sessão encerrada com sucesso." });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// STATUS atualizado
app.get("/status", (req, res) => {
  const isConnected = !!global.sock?.user;
  const number = global.sock?.user?.id
    ? global.sock.user.id.split(":")[0]
    : null;

  res.json({
    status: "online",
    mensagem: "Servidor rodando e pronto para integração com Lovable!",
    conectado: isConnected,
    number
  });
});

// ==================== INICIALIZAÇÃO ====================
startSock();

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
