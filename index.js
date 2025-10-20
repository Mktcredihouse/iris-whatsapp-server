const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const PORT = process.env.PORT || 10000;

// Configurações
const EMPRESA_ID = 'credihouse';
const SUPABASE_URL = 'https://ssbuwpeasbkxobowfyvw.supabase.co';
const BAILEYS_WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || '';

// Logger
const logger = pino({ level: 'info' });

// Armazenar instância do socket
let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ============================================
// INICIALIZAÇÃO DO BAILEYS
// ============================================
async function connectToWhatsApp() {
  const authFolder = path.join(__dirname, 'auth_info_baileys');
  
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: ['IRIS CRM', 'Chrome', '1.0.0']
  });

  // ============================================
  // EVENTO: QR CODE
  // ============================================
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    console.log(`🔌 [${EMPRESA_ID}] Connection update:`, update);
    
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr);
      connectionStatus = 'qr_ready';
      console.log(`📱 [${EMPRESA_ID}] QR Code gerado! Escaneie com o WhatsApp.`);
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ [${EMPRESA_ID}] Conexão fechada. Reconectando: ${shouldReconnect}`);
      connectionStatus = 'disconnected';
      
      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), 3000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      console.log(`✅ [${EMPRESA_ID}] Conectado ao WhatsApp!`);
      qrCodeData = null;
    }
  });

  // ============================================
  // EVENTO: MENSAGENS RECEBIDAS (INCOMING)
  // ============================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log(`🔔 [${EMPRESA_ID}] messages.upsert disparado! Total de mensagens: ${messages.length}`);
    
    for (const msg of messages) {
      console.log(`📋 [${EMPRESA_ID}] Processando mensagem:`, {
        fromMe: msg.key.fromMe,
        remoteJid: msg.key.remoteJid,
        messageType: Object.keys(msg.message || {})[0]
      });
      
      try {
        // Ignora mensagens enviadas por você mesmo
        if (msg.key.fromMe) {
          console.log(`⏭️ [${EMPRESA_ID}] Ignorando mensagem fromMe=true`);
          continue;
        }

        const from = msg.key.remoteJid;
        const messageType = Object.keys(msg.message || {})[0] || 'unknown';
        const messageText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.documentMessage?.fileName ||
          '';

        console.log(`📩 [${EMPRESA_ID}] Mensagem recebida de ${from}:`, messageText);

        const payload = {
          from: from,
          message: messageText,
          type: messageType === 'conversation' ? 'text' : messageType,
          fromMe: false
        };
        
        console.log(`🚀 [${EMPRESA_ID}] Enviando para webhook:`, JSON.stringify(payload));

        // Enviar para o webhook Supabase
        const webhookResponse = await fetch(`${SUPABASE_URL}/functions/v1/baileys-webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Empresa-ID': EMPRESA_ID,
            'X-Webhook-Signature': BAILEYS_WEBHOOK_SECRET
          },
          body: JSON.stringify(payload)
        });
        
        const responseText = await webhookResponse.text();
        console.log(`✅ [${EMPRESA_ID}] Webhook respondeu (${webhookResponse.status}):`, responseText);
        
      } catch (err) {
        console.error(`❌ [${EMPRESA_ID}] Erro ao processar mensagem recebida:`, err.message);
        console.error(`❌ Stack trace:`, err.stack);
      }
    }
  });
}

// ============================================
// ROTAS DA API
// ============================================

// Status da conexão
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    empresa: EMPRESA_ID,
    connected: connectionStatus === 'connected'
  });
});

// Obter QR Code
app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.json({ qr: qrCodeData, status: 'qr_ready' });
  } else if (connectionStatus === 'connected') {
    res.json({ status: 'connected', message: 'Já conectado' });
  } else {
    res.json({ status: 'waiting', message: 'Aguardando QR Code...' });
  }
});

// Enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    if (!sock || connectionStatus !== 'connected') {
      return res.status(503).json({ 
        success: false, 
        error: 'WhatsApp não conectado' 
      });
    }

    const { number, message, media } = req.body;

    if (!number || (!message && !media)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Número e mensagem/mídia são obrigatórios' 
      });
    }

    // Normalizar número para formato WhatsApp
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

    // ÁUDIO
    if (media && media.startsWith('data:audio/')) {
      console.log(`=== AUDIO DEBUG ===`);
      console.log(`[${EMPRESA_ID}] Processando envio de áudio base64...`);
      
      const base64Data = media.split(',')[1] || media;
      console.log(`[${EMPRESA_ID}] Base64 length: ${base64Data.length}`);
      
      const audioBuffer = Buffer.from(base64Data, 'base64');
      console.log(`[${EMPRESA_ID}] Audio buffer size: ${audioBuffer.length} bytes`);

      // Salvar temporariamente
      const tempOggPath = `/tmp/audio-${Date.now()}.ogg`;
      const tempMp3Path = `/tmp/audio-${Date.now()}.mp3`;
      fs.writeFileSync(tempOggPath, audioBuffer);
      console.log(`[${EMPRESA_ID}] Temporary OGG file saved at: ${tempOggPath}`);

      try {
        // Tentar enviar como OGG primeiro
        console.log(`[${EMPRESA_ID}] Tentando enviar como OGG/Opus...`);
        await sock.sendMessage(jid, {
          audio: audioBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
        console.log(`[${EMPRESA_ID}] ✅ Áudio OGG enviado com sucesso.`);
        fs.unlinkSync(tempOggPath);
        console.log(`=== END AUDIO DEBUG ===`);
        return res.json({ success: true, message: 'Áudio OGG enviado com sucesso.' });
      } catch (oggError) {
        console.log(`[${EMPRESA_ID}] ⚠️ Erro ao enviar OGG:`, oggError.message);
        console.log(`[${EMPRESA_ID}] Convertendo para MP3...`);

        // Converter para MP3 usando ffmpeg
        await new Promise((resolve, reject) => {
          ffmpeg(tempOggPath)
            .toFormat('mp3')
            .audioCodec('libmp3lame')
            .audioBitrate('128k')
            .on('end', () => {
              console.log(`[${EMPRESA_ID}] ✅ Conversão para MP3 concluída`);
              resolve();
            })
            .on('error', (err) => {
              console.error(`[${EMPRESA_ID}] ❌ Erro na conversão:`, err.message);
              reject(err);
            })
            .save(tempMp3Path);
        });

        const mp3Buffer = fs.readFileSync(tempMp3Path);
        console.log(`[${EMPRESA_ID}] MP3 buffer size: ${mp3Buffer.length} bytes`);

        await sock.sendMessage(jid, {
          audio: mp3Buffer,
          mimetype: 'audio/mpeg',
          ptt: true
        });

        console.log(`[${EMPRESA_ID}] ✅ Áudio MP3 enviado com sucesso.`);
        
        // Limpar arquivos temporários
        fs.unlinkSync(tempOggPath);
        fs.unlinkSync(tempMp3Path);
        console.log(`=== END AUDIO DEBUG ===`);
        
        return res.json({ success: true, message: 'Áudio MP3 enviado com sucesso.' });
      }
    }

    // IMAGEM
    if (media && media.startsWith('data:image/')) {
      const base64Data = media.split(',')[1] || media;
      const imageBuffer = Buffer.from(base64Data, 'base64');
      
      await sock.sendMessage(jid, {
        image: imageBuffer,
        caption: message || ''
      });
      
      return res.json({ success: true, message: 'Imagem enviada com sucesso.' });
    }

    // DOCUMENTO
    if (media && media.startsWith('data:application/')) {
      const base64Data = media.split(',')[1] || media;
      const docBuffer = Buffer.from(base64Data, 'base64');
      
      await sock.sendMessage(jid, {
        document: docBuffer,
        mimetype: 'application/pdf',
        fileName: 'documento.pdf'
      });
      
      return res.json({ success: true, message: 'Documento enviado com sucesso.' });
    }

    // TEXTO SIMPLES
    await sock.sendMessage(jid, { text: message });
    
    res.json({ success: true, message: 'Mensagem enviada com sucesso.' });
  } catch (error) {
    console.error(`❌ [${EMPRESA_ID}] Erro ao enviar mensagem:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Desconectar
app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
      connectionStatus = 'disconnected';
      qrCodeData = null;
      
      // Limpar auth_info_baileys
      const authFolder = path.join(__dirname, 'auth_info_baileys');
      if (fs.existsSync(authFolder)) {
        fs.rmSync(authFolder, { recursive: true, force: true });
      }
      
      res.json({ success: true, message: 'Desconectado com sucesso' });
    } else {
      res.json({ success: false, message: 'Não está conectado' });
    }
  } catch (error) {
    console.error(`❌ [${EMPRESA_ID}] Erro ao desconectar:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor Baileys rodando na porta ${PORT}`);
  console.log(`📱 Empresa: ${EMPRESA_ID}`);
  connectToWhatsApp();
});
