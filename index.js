import express from "express";
import cors from "cors";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import qrcode from "qrcode";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const WEBHOOK_URL = "https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook"; // << ajuste aqui se precisar

let qrCodeData = null;
let sock;

// Função para iniciar o WhatsApp
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    printQRInTerminal: false, // agora não imprime no terminal
    auth: state,
    browser: ["Ubuntu", "Chrome", "22.04"]
  });

  // Evento de QR
  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      qrCodeData = qr; // guarda o QR para rota /qr
      console.log("✅ Novo QR Code gerado. Acesse /qr para escanear.");
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Conexão encerrada, tentando reconectar...", reason || "");
      startWhatsApp();
    } else if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp com sucesso!");
    }
  });

  // Evento de credenciais atualizadas
  sock.ev.on("creds.update", saveCreds);

  // Evento de mensagens recebidas
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && msg.message) {
      const remoteJid = msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

      console.log(`📩 Mensagem recebida de ${remoteJid}: ${text}`);

      // Envia para Lovable via webhook
      try {
        await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            remoteJid,
            message: text,
            timestamp: Date.now()
          })
        });
      } catch (error) {
        console.error("❌ Erro ao enviar webhook:", error);
      }
    }
  });
}

// Rota para exibir QR Code como imagem PNG
app.get("/qr", async (req, res) => {
  if (!qrCodeData) {
    return res.status(404).send("Nenhum QR Code disponível no momento.");
  }
  try {
    const qrImage = await qrcode.toBuffer(qrCodeData);
    res.setHeader("Content-Type", "image/png");
    res.send(qrImage);
  } catch (error) {
    res.status(500).send("Erro ao gerar QR Code.");
  }
});

// Endpoint para envio de mensagens (Lovable → WhatsApp)
app.post("/send", async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: "Campos 'to' e 'message' são obrigatórios." });
  }

  try {
    await sock.sendMessage(`${to}@s.whatsapp.net`, { text: message });
    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar mensagem:", error);
    res.status(500).json({ error: "Falha ao enviar mensagem" });
  }
});

// Inicia servidor e conexão WhatsApp
app.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP rodando na porta ${PORT}`);
  startWhatsApp();
});
