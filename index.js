const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

// ============================================
// CONFIGURAÇÕES
// ============================================
const PORT = process.env.PORT || 10000;
const EMPRESA_ID = process.env.EMPRESA_ID || 'Credihouse';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ssbuwpeasbkxobowfyvw.supabase.co';
const BAILEYS_WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || '';
const LOG_LEVEL = process.env.LOG_LEVEL || 'debug';

// ============================================
// LOGGER CONFIGURADO
// ============================================
const logger = pino({
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname'
    }
  }
});

// ============================================
// ESTADO GLOBAL DA CONEXÃO
// ============================================
const connectionState = {
  isConnected: false,
  qrCode: null,
  connectedNumber: null
};

// ============================================
// EXPRESS APP
// ============================================
const app = express();
app.use(express.json({ limit: '50mb' }));

// ============================================
// FUNÇÕES AUXILIARES
// ============================================

/**
 * Normaliza número de telefone removendo caracteres especiais
 */
function normalizePhoneNumber(phone) {
  return phone.replace(/\D/g, '');
}

/**
 * Formata número para o formato do WhatsApp
 */
function formatWhatsAppNumber(phone) {
  const normalized = normalizePhoneNumber(phone);
  if (normalized.includes('@')) return normalized;
  return `${normalized}@s.whatsapp.net`;
}

/**
 * Envia payload para o webhook do Supabase
 */
async function sendToWebhook(payload) {
  const webhookUrl = `${SUPABASE_URL}/functions/v1/baileys-webhook`;
  
  logger.debug({ payload, webhookUrl }, '🚀 Enviando para webhook');

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-empresa-id': EMPRESA_ID,
        ...(BAILEYS_WEBHOOK_SECRET && { 'x-webhook-signature': BAILEYS_WEBHOOK_SECRET })
      },
      body: JSON.stringify(payload)
    });

    const responseData = await response.json();
    
    if (!response.ok) {
      logger.error({ status: response.status, data: responseData }, '❌ Erro no webhook');
      return { success: false, error: responseData };
    }

    logger.info({ data: responseData }, '✅ Webhook respondeu com sucesso');
    return { success: true, data: responseData };
  } catch (error) {
    logger.error({ error: error.message }, '❌ Erro ao chamar webhook');
    return { success: false, error: error.message };
  }
}

/**
 * Processa mensagem recebida e envia para webhook
 */
async function processIncomingMessage(sock, msg) {
  try {
    const messageType = Object.keys(msg.message || {})[0];
    const remoteJid = msg.key.remoteJid;
    const isGroupChat = remoteJid.endsWith('@g.us');

    // Ignora mensagens de grupo (opcional)
    if (isGroupChat) {
      logger.debug({ remoteJid }, '⏭️ Ignorando mensagem de grupo');
      return;
    }

    logger.debug({ 
      messageType, 
      remoteJid, 
      fromMe: msg.key.fromMe 
    }, '📋 Processando mensagem');

    let messageText = null;
    let mediaUrl = null;
    let mediaType = 'text';

    // Extrai conteúdo baseado no tipo de mensagem
    switch (messageType) {
      case 'conversation':
        messageText = msg.message.conversation;
        break;
      
      case 'extendedTextMessage':
        messageText = msg.message.extendedTextMessage.text;
        break;
      
      case 'imageMessage':
        mediaType = 'image';
        messageText = msg.message.imageMessage.caption || '';
        // Aqui você pode baixar e fazer upload da imagem se necessário
        break;
      
      case 'videoMessage':
        mediaType = 'video';
        messageText = msg.message.videoMessage.caption || '';
        break;
      
      case 'audioMessage':
        mediaType = 'audio';
        messageText = '[Áudio]';
        break;
      
      case 'documentMessage':
        mediaType = 'document';
        messageText = msg.message.documentMessage.fileName || '[Documento]';
        break;
      
      case 'stickerMessage':
        mediaType = 'sticker';
        messageText = '[Sticker]';
        break;
      
      case 'contactMessage':
        mediaType = 'contact';
        const contact = msg.message.contactMessage;
        messageText = `[Contato: ${contact.displayName}]`;
        break;
      
      case 'locationMessage':
        mediaType = 'location';
        const location = msg.message.locationMessage;
        messageText = `[Localização: ${location.degreesLatitude}, ${location.degreesLongitude}]`;
        break;
      
      default:
        logger.warn({ messageType }, '⚠️ Tipo de mensagem não suportado');
        messageText = '[Mensagem não suportada]';
    }

    // Monta payload para o webhook
    const payload = {
      from: normalizePhoneNumber(remoteJid.split('@')[0]),
      to: connectionState.connectedNumber,
      message: messageText,
      type: mediaType,
      media: mediaUrl,
      fromMe: msg.key.fromMe,
      timestamp: msg.messageTimestamp
    };

    logger.info({ payload }, '📤 Enviando mensagem para webhook');
    await sendToWebhook(payload);

  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, '❌ Erro ao processar mensagem');
  }
}

// ============================================
// INICIALIZAÇÃO DO BAILEYS
// ============================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  logger.info({ version }, '🔄 Iniciando conexão com WhatsApp');

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }), // Silencia logs internos do Baileys
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    getMessage: async (key) => {
      return { conversation: 'Mensagem não encontrada' };
    }
  });

  // ============================================
  // EVENT: connection.update
  // ============================================
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionState.qrCode = qr;
      logger.info('📱 Novo QR Code gerado! Acesse /qr para escanear');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;

      const reason = lastDisconnect?.error?.output?.statusCode || 'desconhecido';
      logger.warn({ reason, shouldReconnect }, '⚠️ Conexão fechada');

      connectionState.isConnected = false;
      connectionState.connectedNumber = null;

      if (shouldReconnect) {
        logger.info('🔄 Reconectando...');
        setTimeout(() => connectToWhatsApp(), 3000);
      }
    } else if (connection === 'open') {
      connectionState.isConnected = true;
      connectionState.qrCode = null;
      connectionState.connectedNumber = sock.user?.id?.split(':')[0] || null;
      
      logger.info({ 
        number: connectionState.connectedNumber 
      }, '✅ Conectado ao WhatsApp!');
    }
  });

  // ============================================
  // EVENT: creds.update
  // ============================================
  sock.ev.on('creds.update', saveCreds);

  // ============================================
  // EVENT: messages.upsert
  // ============================================
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    logger.debug({ 
      count: messages.length, 
      type 
    }, '🔔 messages.upsert disparado');

    for (const msg of messages) {
      // Ignora se não for mensagem de notificação (evita processar mensagens antigas)
      if (type !== 'notify') {
        logger.debug({ type }, '⏭️ Ignorando mensagem (não é notify)');
        continue;
      }

      // Ignora mensagens sem conteúdo
      if (!msg.message) {
        logger.debug('⏭️ Ignorando mensagem sem conteúdo');
        continue;
      }

      const isFromMe = msg.key.fromMe;
      const remoteJid = msg.key.remoteJid;

      logger.debug({
        fromMe: isFromMe,
        remoteJid,
        messageKeys: Object.keys(msg.message)
      }, '📋 Mensagem detectada');

      // PROCESSAR APENAS MENSAGENS RECEBIDAS (fromMe: false)
      if (!isFromMe) {
        logger.info({ 
          from: remoteJid 
        }, '📥 Mensagem RECEBIDA de cliente - processando...');
        
        await processIncomingMessage(sock, msg);
      } else {
        logger.debug('⏭️ Ignorando mensagem enviada pelo sistema (fromMe: true)');
      }
    }
  });

  return sock;
}

// ============================================
// ROTAS EXPRESS
// ============================================

// Status da conexão
app.get('/status', (req, res) => {
  res.json({
    connected: connectionState.isConnected,
    number: connectionState.connectedNumber,
    qrAvailable: !!connectionState.qrCode,
    empresa: EMPRESA_ID
  });
});

// QR Code
app.get('/qr', (req, res) => {
  if (connectionState.isConnected) {
    return res.json({ 
      success: false, 
      message: 'Já conectado ao WhatsApp',
      number: connectionState.connectedNumber
    });
  }

  if (!connectionState.qrCode) {
    return res.json({ 
      success: false, 
      message: 'QR Code ainda não foi gerado. Aguarde...' 
    });
  }

  res.json({ 
    success: true, 
    qrCode: connectionState.qrCode 
  });
});

// Enviar mensagem
app.post('/send-message', async (req, res) => {
  const { number, message, mediaType, mediaData, fileName } = req.body;

  if (!connectionState.isConnected) {
    return res.status(503).json({ 
      success: false, 
      error: 'WhatsApp não conectado' 
    });
  }

  if (!number || !message) {
    return res.status(400).json({ 
      success: false, 
      error: 'Número e mensagem são obrigatórios' 
    });
  }

  try {
    const formattedNumber = formatWhatsAppNumber(number);
    
    logger.info({ 
      to: formattedNumber, 
      messageLength: message.length,
      mediaType 
    }, '📤 Enviando mensagem');

    let result;

    // Envia baseado no tipo de mídia
    switch (mediaType) {
      case 'audio':
        if (!mediaData) {
          return res.status(400).json({ success: false, error: 'mediaData é obrigatório para áudio' });
        }
        const audioBuffer = Buffer.from(mediaData, 'base64');
        result = await global.sock.sendMessage(formattedNumber, {
          audio: audioBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
        break;

      case 'document':
        if (!mediaData || !fileName) {
          return res.status(400).json({ success: false, error: 'mediaData e fileName são obrigatórios para documento' });
        }
        const docBuffer = Buffer.from(mediaData, 'base64');
        result = await global.sock.sendMessage(formattedNumber, {
          document: docBuffer,
          mimetype: 'application/pdf',
          fileName: fileName
        });
        break;

      case 'image':
        if (!mediaData) {
          return res.status(400).json({ success: false, error: 'mediaData é obrigatório para imagem' });
        }
        const imageBuffer = Buffer.from(mediaData, 'base64');
        result = await global.sock.sendMessage(formattedNumber, {
          image: imageBuffer,
          caption: message
        });
        break;

      default:
        // Mensagem de texto simples
        result = await global.sock.sendMessage(formattedNumber, {
          text: message
        });
    }

    logger.info({ result }, '✅ Mensagem enviada com sucesso');
    
    res.json({ 
      success: true, 
      message: 'Mensagem enviada com sucesso',
      messageId: result?.key?.id
    });

  } catch (error) {
    logger.error({ error: error.message }, '❌ Erro ao enviar mensagem');
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Logout
app.post('/logout', async (req, res) => {
  try {
    if (global.sock) {
      await global.sock.logout();
      logger.info('👋 Logout realizado');
    }
    
    connectionState.isConnected = false;
    connectionState.qrCode = null;
    connectionState.connectedNumber = null;

    res.json({ success: true, message: 'Desconectado com sucesso' });
  } catch (error) {
    logger.error({ error: error.message }, '❌ Erro ao fazer logout');
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    empresa: EMPRESA_ID
  });
});

// ============================================
// INICIALIZAÇÃO
// ============================================
(async () => {
  try {
    global.sock = await connectToWhatsApp();
    
    app.listen(PORT, () => {
      logger.info({ 
        port: PORT, 
        empresa: EMPRESA_ID 
      }, '🚀 Servidor Baileys iniciado');
    });
  } catch (error) {
    logger.error({ error: error.message }, '❌ Erro fatal ao iniciar');
    process.exit(1);
  }
})();

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGINT', async () => {
  logger.info('🛑 Encerrando servidor...');
  if (global.sock) {
    await global.sock.end();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('🛑 Encerrando servidor...');
  if (global.sock) {
    await global.sock.end();
  }
  process.exit(0);
});
