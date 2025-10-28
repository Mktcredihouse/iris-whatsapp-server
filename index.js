const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');

// ==================== CONFIGURAÇÃO ====================
const PORT = process.env.PORT || 10000;
const EMPRESA_ID = process.env.EMPRESA_ID || '03e6a1b3-e741-4dbc-a0bc-0d922ecd0a12';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ssbuwpeasbkxobowfyvw.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BAILEYS_WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || 'webhook-secret-key';

// Cliente Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Express app
const app = express();
app.use(express.json());

// ==================== ESTADO GLOBAL ====================
let sock = null;
let lastQR = null;
let connectionStatus = {
  connected: false,
  number: null,
  lastUpdate: new Date().toISOString()
};

// ==================== FUNÇÃO DE CONEXÃO ====================
async function connectToWhatsApp() {
  try {
    console.log('🔄 Iniciando conexão com WhatsApp...');
    
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      getMessage: async () => ({ conversation: 'Mensagem não disponível' }),
    });

    // ==================== EVENTO: CONNECTION UPDATE ====================
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR Code gerado
      if (qr) {
        console.log('📱 QR Code gerado!');
        lastQR = qr;
        
        // Exibir QR no terminal
        qrcode.generate(qr, { small: true });
        
        connectionStatus.connected = false;
        connectionStatus.lastUpdate = new Date().toISOString();
      }

      // Conexão fechada
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('❌ Conexão fechada. Reconectar?', shouldReconnect);
        
        connectionStatus.connected = false;
        connectionStatus.number = null;
        connectionStatus.lastUpdate = new Date().toISOString();
        lastQR = null;

        if (shouldReconnect) {
          console.log('🔄 Reconectando em 5 segundos...');
          setTimeout(() => connectToWhatsApp(), 5000);
        } else {
          console.log('🚪 Sessão encerrada (logout)');
        }
      } 
      // Conexão aberta
      else if (connection === 'open') {
        console.log('✅ Conectado ao WhatsApp!');
        
        // Obter número conectado
        const me = sock.user;
        const phoneNumber = me?.id?.split(':')[0] || 'Desconhecido';
        
        connectionStatus.connected = true;
        connectionStatus.number = phoneNumber;
        connectionStatus.lastUpdate = new Date().toISOString();
        lastQR = null;

        console.log(`📞 Número conectado: ${phoneNumber}`);

        // Atualizar no banco
        try {
          await supabase
            .from('whatsapp_connection')
            .upsert({
              company_id: EMPRESA_ID,
              is_connected: true,
              connected_number: phoneNumber,
              last_connected_at: new Date().toISOString(),
              server_url: `http://72.60.254.219:${PORT}`
            });
          console.log('✅ Status atualizado no banco de dados');
        } catch (error) {
          console.error('❌ Erro ao atualizar banco:', error);
        }
      }
    });

    // ==================== EVENTO: MENSAGENS RECEBIDAS ====================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        // Ignorar mensagens enviadas por mim
        if (message.key.fromMe) {
          console.log('⏭️ Mensagem ignorada (enviada por mim)');
          continue;
        }

        const from = message.key.remoteJid;
        const phoneNumber = from.split('@')[0];
        
        console.log('📨 Nova mensagem recebida de:', phoneNumber);

        // Extrair texto da mensagem
        let messageText = '';
        if (message.message?.conversation) {
          messageText = message.message.conversation;
        } else if (message.message?.extendedTextMessage?.text) {
          messageText = message.message.extendedTextMessage.text;
        } else if (message.message?.imageMessage?.caption) {
          messageText = message.message.imageMessage.caption;
        } else if (message.message?.videoMessage?.caption) {
          messageText = message.message.videoMessage.caption;
        }

        // Detectar tipo de mídia
        let mediaType = null;
        let mediaUrl = null;
        
        if (message.message?.imageMessage) {
          mediaType = 'image';
          console.log('📷 Imagem recebida');
        } else if (message.message?.audioMessage) {
          mediaType = 'audio';
          console.log('🎤 Áudio recebido');
        } else if (message.message?.videoMessage) {
          mediaType = 'video';
          console.log('🎥 Vídeo recebido');
        } else if (message.message?.documentMessage) {
          mediaType = 'document';
          console.log('📄 Documento recebido');
        }

        // Salvar no banco (chat_mensagens)
        try {
          const { error: insertError } = await supabase
            .from('chat_mensagens')
            .insert({
              company_id: EMPRESA_ID,
              lead_phone: phoneNumber,
              message_text: messageText || null,
              media_type: mediaType,
              media_url: mediaUrl,
              sender_type: 'lead',
              sender_name: from,
              is_read: false,
              created_at: new Date().toISOString()
            });

          if (insertError) {
            console.error('❌ Erro ao salvar mensagem:', insertError);
          } else {
            console.log('✅ Mensagem salva no banco');
          }
        } catch (error) {
          console.error('❌ Erro ao processar mensagem:', error);
        }

        // Enviar webhook
        try {
          const webhookPayload = {
            companyId: EMPRESA_ID,
            from: phoneNumber,
            message: messageText,
            mediaType: mediaType,
            mediaUrl: mediaUrl,
            timestamp: new Date().toISOString(),
            fromMe: false
          };

          const webhookResponse = await fetch(`${SUPABASE_URL}/functions/v1/baileys-webhook`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
              'x-webhook-secret': BAILEYS_WEBHOOK_SECRET
            },
            body: JSON.stringify(webhookPayload)
          });

          if (webhookResponse.ok) {
            console.log('✅ Webhook enviado com sucesso');
          } else {
            console.error('❌ Erro no webhook:', webhookResponse.status);
          }
        } catch (webhookError) {
          console.error('❌ Erro ao enviar webhook:', webhookError);
        }
      }
    });

    // ==================== EVENTO: SALVAR CREDENCIAIS ====================
    sock.ev.on('creds.update', saveCreds);

  } catch (error) {
    console.error('❌ Erro na conexão:', error);
    setTimeout(() => connectToWhatsApp(), 5000);
  }
}

// ==================== ENDPOINTS API ====================

// Status da conexão
app.get('/status', (req, res) => {
  res.json({
    success: true,
    connected: connectionStatus.connected,
    number: connectionStatus.number,
    lastUpdate: connectionStatus.lastUpdate,
    hasQR: !!lastQR
  });
});

// Retornar QR Code
app.get('/qr', (req, res) => {
  if (lastQR) {
    res.json({
      success: true,
      qr: lastQR,
      message: 'QR code disponível'
    });
  } else if (connectionStatus.connected) {
    res.json({
      success: false,
      message: 'Já está conectado',
      number: connectionStatus.number
    });
  } else {
    res.json({
      success: false,
      message: 'QR code não disponível ainda. Aguarde...'
    });
  }
});

// Enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    const { to, message, mediaUrl } = req.body;

    if (!sock || !connectionStatus.connected) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp não está conectado'
      });
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    if (mediaUrl) {
      await sock.sendMessage(jid, {
        image: { url: mediaUrl },
        caption: message
      });
    } else {
      await sock.sendMessage(jid, { text: message });
    }

    console.log('✅ Mensagem enviada para:', to);

    res.json({
      success: true,
      message: 'Mensagem enviada com sucesso'
    });
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Logout
app.get('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }

    connectionStatus.connected = false;
    connectionStatus.number = null;
    connectionStatus.lastUpdate = new Date().toISOString();
    lastQR = null;

    // Atualizar banco
    await supabase
      .from('whatsapp_connection')
      .update({ 
        is_connected: false,
        connected_number: null
      })
      .eq('company_id', EMPRESA_ID);

    res.json({
      success: true,
      message: 'Desconectado com sucesso'
    });
  } catch (error) {
    console.error('❌ Erro ao fazer logout:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor Baileys rodando na porta ${PORT}`);
  console.log(`🌐 Endereço: http://72.60.254.219:${PORT}`);
  console.log(`🏢 Empresa ID: ${EMPRESA_ID}`);
  connectToWhatsApp();
});
