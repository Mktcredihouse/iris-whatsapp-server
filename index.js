// IMPORTANTE: Carregar variáveis ANTES de qualquer outra coisa
import dotenv from 'dotenv';
dotenv.config();

import { Boom } from '@hapi/boom';
import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import express from 'express';
import qrcode from 'qrcode';
import { createClient } from '@supabase/supabase-js';

// ===== CONFIGURAÇÕES =====
const PORT = process.env.PORT || 10000;
const EMPRESA_ID = process.env.EMPRESA_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BAILEYS_WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || 'default-secret';

// Log para debug
console.log('🔍 Verificando variáveis de ambiente:');
console.log('   PORT:', PORT);
console.log('   EMPRESA_ID:', EMPRESA_ID ? '✅ Definido' : '❌ Não definido');
console.log('   SUPABASE_URL:', SUPABASE_URL ? '✅ Definido' : '❌ Não definido');
console.log('   SUPABASE_ANON_KEY:', SUPABASE_ANON_KEY ? '✅ Definido' : '❌ Não definido');

// Validar variáveis críticas
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('\n❌ ERRO CRÍTICO: Variáveis de ambiente não foram carregadas!');
  console.error('📝 Verifique se o arquivo .env existe em:', process.cwd());
  console.error('📝 Conteúdo esperado do .env:');
  console.error('   PORT=10000');
  console.error('   EMPRESA_ID=03e6a1b3-e741-4dbc-a0bc-0d922ecd0a12');
  console.error('   SUPABASE_URL=https://...');
  console.error('   SUPABASE_ANON_KEY=eyJ...');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
console.log('✅ Cliente Supabase criado com sucesso\n');

// ===== ESTADO GLOBAL =====
let sock = null;
let lastQR = null;
let connectionStatus = {
  connected: false,
  number: null,
  lastUpdate: new Date().toISOString()
};

// ===== EXPRESS API =====
const app = express();
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env_loaded: !!SUPABASE_URL
  });
});

// Status da conexão
app.get('/status', (req, res) => {
  res.json({
    connected: connectionStatus.connected,
    number: connectionStatus.number,
    lastUpdate: connectionStatus.lastUpdate,
    hasQR: !!lastQR
  });
});

// Obter QR Code
app.get('/qr', (req, res) => {
  if (!lastQR) {
    return res.status(404).json({ 
      error: 'QR code não disponível',
      message: connectionStatus.connected 
        ? 'WhatsApp já está conectado' 
        : 'Aguardando geração do QR code...'
    });
  }
  
  res.json({ 
    qr: lastQR,
    message: 'QR code disponível para escaneamento'
  });
});

// Enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    const { to, message, mediaUrl } = req.body;
    
    if (!connectionStatus.connected || !sock) {
      return res.status(503).json({ 
        error: 'WhatsApp não conectado',
        connected: false
      });
    }

    const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;

    let sentMessage;
    if (mediaUrl) {
      sentMessage = await sock.sendMessage(jid, {
        image: { url: mediaUrl },
        caption: message || ''
      });
    } else {
      sentMessage = await sock.sendMessage(jid, { text: message });
    }

    console.log('✅ Mensagem enviada:', { to: jid, message });
    res.json({ 
      success: true, 
      messageId: sentMessage.key.id 
    });

  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error);
    res.status(500).json({ 
      error: 'Erro ao enviar mensagem',
      details: error.message 
    });
  }
});

// Logout
app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      connectionStatus.connected = false;
      connectionStatus.number = null;
      lastQR = null;
      console.log('✅ Logout realizado com sucesso');
    }
    res.json({ success: true, message: 'Logout realizado' });
  } catch (error) {
    console.error('❌ Erro no logout:', error);
    res.status(500).json({ 
      error: 'Erro ao fazer logout',
      details: error.message 
    });
  }
});

// Iniciar servidor Express
app.listen(PORT, () => {
  console.log(`\n✅ Servidor HTTP rodando na porta ${PORT}`);
  console.log(`📍 Endpoints disponíveis:`);
  console.log(`   - GET  http://localhost:${PORT}/health`);
  console.log(`   - GET  http://localhost:${PORT}/status`);
  console.log(`   - GET  http://localhost:${PORT}/qr`);
  console.log(`   - POST http://localhost:${PORT}/send-message`);
  console.log(`   - POST http://localhost:${PORT}/logout\n`);
});

// ===== BAILEYS WHATSAPP =====
async function connectToWhatsApp() {
  console.log('🔄 Iniciando conexão com WhatsApp...\n');
  
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: true,
    syncFullHistory: false,
  });

  // ===== EVENT: ATUALIZAÇÃO DE CONEXÃO =====
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code gerado
    if (qr) {
      lastQR = qr;
      connectionStatus.lastUpdate = new Date().toISOString();
      
      console.log('\n╔═══════════════════════════════════════════╗');
      console.log('║   📱 QR CODE - ESCANEIE COM SEU WHATSAPP  ║');
      console.log('╚═══════════════════════════════════════════╝\n');
      
      // Gerar QR code no terminal
      qrcode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
        if (!err) {
          console.log(url);
          console.log('\n╔═══════════════════════════════════════════╗');
          console.log('║  👆 Escaneie o QR Code acima com o app   ║');
          console.log('╚═══════════════════════════════════════════╝\n');
        }
      });
    }

    // Conexão estabelecida
    if (connection === 'open') {
      lastQR = null;
      connectionStatus.connected = true;
      connectionStatus.lastUpdate = new Date().toISOString();
      
      const user = sock.user;
      const phoneNumber = user?.id?.split(':')[0] || 'Desconhecido';
      connectionStatus.number = phoneNumber;

      console.log('\n✅ ═══════════════════════════════════');
      console.log('✅ CONECTADO AO WHATSAPP COM SUCESSO!');
      console.log('✅ ═══════════════════════════════════');
      console.log('📱 Número:', phoneNumber);
      console.log('🕐 Horário:', new Date().toLocaleString('pt-BR'));
      console.log('═══════════════════════════════════\n');

      // Atualizar no Supabase
      try {
        await supabase
          .from('whatsapp_connection')
          .update({
            is_connected: true,
            connected_number: phoneNumber,
            last_connected_at: new Date().toISOString()
          })
          .eq('company_id', EMPRESA_ID);
        
        console.log('✅ Status atualizado no banco de dados\n');
      } catch (error) {
        console.error('⚠️  Erro ao atualizar banco:', error.message);
      }
    }

    // Conexão fechada
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;

      connectionStatus.connected = false;
      connectionStatus.lastUpdate = new Date().toISOString();

      console.log('\n❌ Conexão fechada');
      console.log('📝 Motivo:', lastDisconnect?.error?.message || 'Desconhecido');

      if (shouldReconnect) {
        console.log('🔄 Reconectando em 5 segundos...\n');
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('🚪 Sessão encerrada (logout manual)\n');
        connectionStatus.number = null;
      }
    }
  });

  // ===== EVENT: CREDENCIAIS ATUALIZADAS =====
  sock.ev.on('creds.update', saveCreds);

  // ===== EVENT: MENSAGENS RECEBIDAS =====
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      // Ignorar mensagens enviadas por nós
      if (msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const messageText = msg.message?.conversation 
        || msg.message?.extendedTextMessage?.text 
        || '';

      console.log('📨 Nova mensagem recebida:');
      console.log('   De:', remoteJid);
      console.log('   Texto:', messageText.substring(0, 100));

      // Salvar no Supabase
      try {
        await supabase.from('chat_messages').insert({
          company_id: EMPRESA_ID,
          phone: remoteJid.split('@')[0],
          message_text: messageText,
          sender_name: msg.pushName || 'Desconhecido',
          from_me: false,
          whatsapp_message_id: msg.key.id
        });

        console.log('   ✅ Salva no banco de dados\n');
      } catch (error) {
        console.error('   ❌ Erro ao salvar:', error.message, '\n');
      }
    }
  });
}

// Iniciar conexão WhatsApp
connectToWhatsApp().catch(err => {
  console.error('❌ Erro fatal ao conectar:', err);
  process.exit(1);
});
