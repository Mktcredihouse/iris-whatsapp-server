import express from "express";
import qrcode from "qrcode-terminal";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const WEBHOOK_URL = "https://seu-endpoint-do-lovable.com/webhook"; // 🔧 Substitua se necessário

// ============================
// 🔌 Inicialização do WhatsApp
// ============================
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
  });

  // 🔁 Atualiza credenciais sempre que algo mudar
  sock.ev.on("creds.update", saveCreds);

  // =========================
  // 📲 Eventos de Conexão
  // =========================
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📲 Escaneie o QR Code abaixo para conectar:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
    } else if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log(
        "⚠️ Conexão encerrada. Tentando reconectar:",
        shouldReconnect
      );
      if (shouldReconnect) startSock();
    }
  });

  // =========================
  // 💬 Eventos de Mensagens
  // =========================
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
      console.log("📩 Webhook enviado para Lovable:", payload);
    } catch (error) {
      console.error("❌ Erro ao enviar webhook:", error);
    }
  });

  return sock;
}

// Variável global do socket
let sock;

// Inicia o socket
startSock().then((s) => {
  sock = s;
});

// =============================
// 🚀 Endpoint: Enviar Mensagem
// =============================
app.post("/send", async (req, res) => {
  const { number, message } = req.body;
  try {
    await sock.sendMessage(`${number}@s.whatsapp.net`, { text: message });
    res.json({ status: "ok", number, message });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// =============================
// 🔐 Endpoint: Logout Manual
// =============================
app.get("/logout", async (req, res) => {
  try {
    await sock.logout();
    res.json({ status: "ok", message: "Sessão encerrada com sucesso." });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// =============================
// 📊 Endpoint: Status do Servidor
// =============================
app.get("/status", (req, res) => {
  const isConnected = !!sock?.user; // verifica se há sessão ativa
  const number = sock?.user?.id ? sock.user.id.split(":")[0] : null; // pega o número do WhatsApp

  res.json({
    status: "online",
    mensagem: "Servidor rodando e pronto para integração com Lovable!",
    conectado: isConnected,
    number: number,
  });
});

// =============================
// 🟢 Inicialização do Servidor
// =============================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
