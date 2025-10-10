import express from "express";
import cors from "cors";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys";
import P from "pino";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

// ======================
// 🔐 CONFIGURAÇÕES GERAIS
// ======================
const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());
app.use(cors());

// ✅ Config Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const AUTH_FOLDER = "./auth_info";

// Função para baixar auth do Supabase
async function restoreAuthInfo() {
  const { data, error } = await supabase.storage
    .from("whatsapp-auth")
    .download("auth.zip");

  if (data) {
    const fileBuffer = await data.arrayBuffer();
    fs.writeFileSync("auth.zip", Buffer.from(fileBuffer));
    console.log("✅ Auth restaurado do Supabase");

    // unzip
    const unzipper = await import("adm-zip");
    const zip = new unzipper.default("auth.zip");
    zip.extractAllTo(AUTH_FOLDER, true);
    fs.unlinkSync("auth.zip");
  } else {
    console.log("⚠️ Nenhum auth.zip encontrado no Supabase (primeira conexão)");
  }
}

// Função para salvar auth no Supabase
async function saveAuthInfo() {
  const zipper = await import("adm-zip");
  const zip = new zipper.default();
  zip.addLocalFolder(AUTH_FOLDER);
  zip.writeZip("auth.zip");

  const fileBuffer = fs.readFileSync("auth.zip");

  const { error } = await supabase.storage
    .from("whatsapp-auth")
    .upload("auth.zip", fileBuffer, { upsert: true });

  fs.unlinkSync("auth.zip");

  if (error) {
    console.error("❌ Erro ao salvar auth:", error);
  } else {
    console.log("✅ Auth salvo no Supabase");
  }
}

// ======================
// 📲 INICIALIZAR BAILEYS
// ======================
async function startWhatsApp() {
  await restoreAuthInfo();

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })),
    },
    logger: P({ level: "silent" })
  });

  // Evento de atualização da conexão
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp com sucesso!");
      await saveAuthInfo();
    } else if (connection === "close") {
      console.log("⚠️ Conexão fechada, tentando reconectar...");
      startWhatsApp();
    }
  });

  // Salvar credenciais sempre que forem atualizadas
  sock.ev.on("creds.update", saveCreds);

  // Receber mensagens e enviar para o webhook do Lovable
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const webhookURL = "https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook";

    await fetch(webhookURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remoteJid: m.key.remoteJid,
        message: m.message.conversation || m.message.extendedTextMessage?.text,
        timestamp: m.messageTimestamp,
      }),
    });
  });

  // Endpoint para envio de mensagens via API
  app.post("/send", async (req, res) => {
    const { to, message } = req.body;

    try {
      await sock.sendMessage(to, { text: message });
      res.json({ success: true });
    } catch (err) {
      console.error("Erro ao enviar mensagem:", err);
      res.status(500).json({ success: false });
    }
  });
}

startWhatsApp();

// ======================
// 🚀 SERVIDOR EXPRESS
// ======================
app.listen(PORT, () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
});
