import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  downloadMediaMessage,
  makeInMemoryStore
} from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import { Boom } from '@hapi/boom';
import express from 'express';
import qrcode from 'qrcode-terminal';
import fetch from 'node-fetch';
import 'dotenv/config';

// Configurações do ambiente
const PORT = process.env.PORT || 10000;
const EMPRESA_ID = process.env.EMPRESA_ID || 'credihouse';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Validar variáveis obrigatórias
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ ERRO: SUPABASE_URL e SUPABASE_KEY são obrigatórios no .env');
  process.exit(1);
}

console.log('✅ Variáveis de ambiente carregadas');

// Inicializar Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
console.log('✅ Supabase inicializado corretamente');

// Inicializar Express
const app = express();
app.use(express.json());

// Estado global da conexão
let sock;
let connectionStatus = {
  connected: false,
  number: null,
  lastUpdate: null,
  qrCode: null
};

// Conectar ao WhatsApp
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: { level: 'silent' }
    });

    // Evento: atualização de conexão
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('📱 Gerando QR Code...');
        qrcode.generate(qr, { small: true });
        connectionStatus.qrCode = qr;
        connectionStatus.lastUpdate = new Date().toISOString();

        // Salvar QR no Supabase
        await supabase
          .from('whatsapp_connection')
          .upsert({
            company_id: EMPRESA_ID,
            qr_code: qr,
            status: 'pending',
            updated_at: new Date().toISOString()
          }, { onConflict: 'company_id' });
      }

      if (connection === 'close') {
        const shouldReconnect = 
          (lastDisconnect?.error instanceof Boom) &&
          lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;

        console.log('❌ Conexão fechada. Reconectar?', shouldReconnect);

        if (shouldReconnect) {
          setTimeout(() => connectToWhatsApp(), 3000);
        }

        connectionStatus.connected = false;
        connectionStatus.number = null;
        connectionStatus.lastUpdate = new Date().toISOString();

        await supabase
          .from('whatsapp_connection')
          .update({
            status: 'disconnected',
            phone_number: null,
            updated_at: new Date().toISOString()
          })
          .eq('company_id', EMPRESA_ID);
      }

      if (connection === 'open') {
        console.log('✅ Conectado ao WhatsApp!');
        const phoneNumber = sock.user.id.split(':')[0];
        console.log(`📱 Número: +${phoneNumber}`);

        connectionStatus.connected = true;
        connectionStatus.number = phoneNumber;
        connectionStatus.qrCode = null;
        connectionStatus.lastUpdate = new Date().toISOString();

        await supabase
          .from('whatsapp_connection')
          .upsert({
            company_id: EMPRESA_ID,
            phone_number: phoneNumber,
            status: 'connected',
            qr_code: null,
            updated_at: new Date().toISOString()
          }, { onConflict: 'company_id' });
      }
    });

    // Evento: credenciais atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Evento: atualização de status de mensagens (CHECKS AZUIS)
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        try {
          const { key, update: status } = update;
          
          if (status?.status) {
            const messageId = key.id;
            const readStatus = status.status.toString().toLowerCase();
            
            console.log(`📊 Status atualizado - ID: ${messageId}, Status: ${readStatus}`);

            // Chamar edge function para atualizar no banco
            const response = await fetch(
              `${SUPABASE_URL}/functions/v1/whatsapp-message-status`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${SUPABASE_KEY}`
                },
                body: JSON.stringify({
                  messageId,
                  status: readStatus,
                  timestamp: Date.now()
                })
              }
            );

            if (response.ok) {
              console.log(`✅ Status salvo no banco: ${messageId} -> ${readStatus}`);
            } else {
              const error = await response.text();
              console.error(`❌ Erro ao salvar status: ${error}`);
            }
          }
        } catch (error) {
          console.error('❌ Erro ao processar messages.update:', error);
        }
      }
    });

    // Evento: novas mensagens recebidas
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        try {
          if (message.key.fromMe) continue;

          const sender = message.key.remoteJid;
          const messageType = Object.keys(message.message || {})[0];
          
          console.log(`📩 Mensagem recebida de ${sender} - Tipo: ${messageType}`);

          let messageText = '';
          let mediaUrl = null;
          let mediaType = null;

          // Processar diferentes tipos de mensagem
          if (messageType === 'conversation') {
            messageText = message.message.conversation;
          } else if (messageType === 'extendedTextMessage') {
            messageText = message.message.extendedTextMessage.text;
          } else if (messageType === 'imageMessage') {
            mediaType = 'image';
            const buffer = await downloadMediaMessage(message, 'buffer', {});
            const fileName = `${Date.now()}.jpg`;
            
            const { data: uploadData, error: uploadError } = await supabase.storage
              .from('chat-files')
              .upload(fileName, buffer, { contentType: 'image/jpeg' });

            if (!uploadError) {
              const { data: { publicUrl } } = supabase.storage
                .from('chat-files')
                .getPublicUrl(fileName);
              mediaUrl = publicUrl;
            }

            messageText = message.message.imageMessage.caption || '[Imagem]';
          } else if (messageType === 'audioMessage') {
            mediaType = 'audio';
            const buffer = await downloadMediaMessage(message, 'buffer', {});
            const fileName = `${Date.now()}.ogg`;
            
            const { data: uploadData, error: uploadError } = await supabase.storage
              .from('chat-files')
              .upload(fileName, buffer, { contentType: 'audio/ogg' });

            if (!uploadError) {
              const { data: { publicUrl } } = supabase.storage
                .from('chat-files')
                .getPublicUrl(fileName);
              mediaUrl = publicUrl;
            }

            messageText = '[Áudio]';
          } else if (messageType === 'videoMessage') {
            mediaType = 'video';
            const buffer = await downloadMediaMessage(message, 'buffer', {});
            const fileName = `${Date.now()}.mp4`;
            
            const { data: uploadData, error: uploadError } = await supabase.storage
              .from('chat-files')
              .upload(fileName, buffer, { contentType: 'video/mp4' });

            if (!uploadError) {
              const { data: { publicUrl } } = supabase.storage
                .from('chat-files')
                .getPublicUrl(fileName);
              mediaUrl = publicUrl;
            }

            messageText = message.message.videoMessage.caption || '[Vídeo]';
          } else if (messageType === 'documentMessage') {
            mediaType = 'document';
            messageText = message.message.documentMessage.fileName || '[Documento]';
          }

          // Capturar foto de perfil do contato
          let profilePicUrl = null;
          try {
            profilePicUrl = await sock.profilePictureUrl(sender, 'image');
            console.log(`🖼️ Foto de perfil capturada para ${sender}`);
          } catch (err) {
            console.log(`⚠️ Sem foto de perfil pública para ${sender}`);
          }

          // Enviar para webhook
          if (WEBHOOK_URL) {
            const webhookPayload = {
              companyId: EMPRESA_ID,
              from: sender,
              message: messageText,
              timestamp: message.messageTimestamp,
              messageType,
              mediaUrl,
              mediaType,
              profilePicUrl,
              pushName: message.pushName || 'Desconhecido'
            };

            console.log('📤 Enviando para webhook:', WEBHOOK_URL);

            const response = await fetch(WEBHOOK_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-company-id': EMPRESA_ID,
                ...(WEBHOOK_SECRET && { 'x-webhook-secret': WEBHOOK_SECRET })
              },
              body: JSON.stringify(webhookPayload)
            });

            if (response.ok) {
              console.log('✅ Webhook enviado com sucesso');
            } else {
              console.error('❌ Erro no webhook:', await response.text());
            }
          }

        } catch (error) {
          console.error('❌ Erro ao processar mensagem:', error);
        }
      }
    });

  } catch (error) {
    console.error('❌ Erro ao conectar:', error);
    setTimeout(() => connectToWhatsApp(), 5000);
  }
}

// Endpoint: verificar status
app.get('/status', (req, res) => {
  res.json({
    connected: connectionStatus.connected,
    number: connectionStatus.number,
    lastUpdate: connectionStatus.lastUpdate,
    hasQR: !!connectionStatus.qrCode
  });
});

// Endpoint: enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    if (!connectionStatus.connected) {
      return res.status(503).json({ 
        success: false, 
        error: 'WhatsApp não conectado' 
      });
    }

    const { phone, message, mediaUrl, mediaType } = req.body;

    if (!phone || (!message && !mediaUrl)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Telefone e mensagem/mídia são obrigatórios' 
      });
    }

    const formattedPhone = phone.includes('@s.whatsapp.net') 
      ? phone 
      : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

    let sentMsg;

    if (mediaUrl) {
      // Enviar mídia
      const mediaBuffer = await fetch(mediaUrl).then(r => r.buffer());
      
      if (mediaType === 'image') {
        sentMsg = await sock.sendMessage(formattedPhone, {
          image: mediaBuffer,
          caption: message || ''
        });
      } else if (mediaType === 'video') {
        sentMsg = await sock.sendMessage(formattedPhone, {
          video: mediaBuffer,
          caption: message || ''
        });
      } else if (mediaType === 'audio') {
        sentMsg = await sock.sendMessage(formattedPhone, {
          audio: mediaBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
      } else if (mediaType === 'document') {
        sentMsg = await sock.sendMessage(formattedPhone, {
          document: mediaBuffer,
          fileName: message || 'document.pdf'
        });
      }
    } else {
      // Enviar texto
      sentMsg = await sock.sendMessage(formattedPhone, { text: message });
    }

    console.log('✅ Mensagem enviada:', sentMsg.key.id);

    res.status(200).json({ 
      success: true, 
      message: 'Mensagem enviada com sucesso',
      messageId: sentMsg.key.id,  // ID da mensagem do Baileys
      key: sentMsg.key             // Chave completa da mensagem
    });

  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Endpoint: logout
app.get('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      console.log('✅ Logout realizado');

      connectionStatus = {
        connected: false,
        number: null,
        lastUpdate: new Date().toISOString(),
        qrCode: null
      };

      await supabase
        .from('whatsapp_connection')
        .update({
          status: 'disconnected',
          phone_number: null,
          qr_code: null,
          updated_at: new Date().toISOString()
        })
        .eq('company_id', EMPRESA_ID);

      res.json({ success: true, message: 'Logout realizado com sucesso' });
    } else {
      res.status(400).json({ success: false, error: 'Nenhuma sessão ativa' });
    }
  } catch (error) {
    console.error('❌ Erro no logout:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 [${EMPRESA_ID}] Servidor rodando na porta ${PORT}`);
  connectToWhatsApp();
});
