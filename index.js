import express from "express";
import qrcode from "qrcode-terminal";
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";
import P from "pino";
import fs from "fs";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const SESSION_DIR = "./auth_info_baileys";
const PORT = 10000;
const WEBHOOK_URL = "https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook";

let sock;

// Função principal de conexão com o WhatsApp
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: P({ level: "fatal" }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })),
    },
    browser: ["Ubuntu", "Chrome", "22.04"],
  });

  // =================== Webhook Lovable ===================
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const payload = {
      from: msg.key.remoteJid,
      message:
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "[Mídia]",
      name: msg.pushName || "Contato desconhecido",
    };

    try {
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log("📤 Webhook enviado para Lovable:", payload);
    } catch (error) {
      console.error("Erro ao enviar webhook:", error);
    }
  });
  // =================== Fim Webhook Lovable ===================

  // =================== Conexão e QR Code ===================
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 ESCANEIE O QR CODE ABAIXO PARA CONECTAR AO WHATSAPP:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp com sucesso!");
    } else if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Conexão encerrada:", reason);
      setTimeout(startSock, 5000);
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// =================== Endpoint: Enviar mensagem ===================
app.post("/send", async (req, res) => {
  const { number, message } = req.body;
  try {
    await sock.sendMessage(`${number}@s.whatsapp.net`, { text: message });
    res.json({ status: "ok", number, message });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// =================== Endpoint: Logout manual ===================
app.get("/logout", async (req, res) => {
  try {
    await sock.logout();
    res.json({ status: "ok", message: "Sessão encerrada com sucesso." });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// =================== Endpoint: Status ===================
app.get("/status", (req, res) => {
  const isConnected = sock?.user ? true : false;
  const number = sock?.user?.id ? sock.user.id.split(":")[0] : null;

  res.json({
    status: "online",
    mensagem: "Servidor rodando e pronto para integração com Lovable!",
    conectado: isConnected,
    number: number,
  });
});

// =================== Inicialização ===================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

startSock();
