import { Boom } from '@hapi/boom'
import { createClient } from '@supabase/supabase-js'
import {
  DisconnectReason,
  downloadMediaMessage,
  makeWASocket,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'
import dotenv from 'dotenv'
import express from 'express'
import fetch from 'node-fetch'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import crypto from 'crypto';


dotenv.config()

// ================================
// 🔧 CONFIGURAÇÕES GERAIS
// ================================
const PORT = process.env.PORT || 10000
const EMPRESA_ID = process.env.EMPRESA_ID || 'empresa-desconhecida'
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ssbuwpeasbkxobowfyvw.supabase.co"
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
const BAILEYS_WEBHOOK_SECRET = "29892e8957b5a37fb9f3880e3e5b73231b1caa445d7fac035a3383a0b4403f17"

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const app = express()

// ✅ CORREÇÃO: Aumentar limite de payload para 50MB
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

let sock = null
let connectionStatus = {
  connected: false,
  number: null,
  lastUpdate: null
}

function generateWebhookSignature(bodyString, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(bodyString)
    .digest('hex');
}

// ================================
// 🔐 CONEXÃO COM WHATSAPP
// ================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  // const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    // version,
    printQRInTerminal: false,
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['IRIS CRM', 'Chrome', '4.0']
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.clear()
      console.log(`📱 [${EMPRESA_ID}] Escaneie o QR Code abaixo para conectar o WhatsApp:`)
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`⚠️ [${EMPRESA_ID}] Conexão encerrada:`, reason)
      connectionStatus.connected = false
      connectionStatus.number = null
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔄 Tentando reconectar...')
        connectToWhatsApp()
      }
    }

    if (connection === 'open') {
      const user = sock?.user?.id?.split(':')[0]
      console.log(`✅ [${EMPRESA_ID}] WhatsApp conectado com sucesso! Número: ${user}`)
      connectionStatus = {
        connected: true,
        number: user,
        lastUpdate: new Date().toISOString()
      }
    }
  })

  // ================================
  // 💬 RECEBIMENTO DE MENSAGENS
  // ================================
  // ✅ CORREÇÃO: Remover listeners antigos para evitar duplicação
  sock.ev.removeAllListeners('messages.upsert')

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    // ⚠️ CRÍTICO: Ignorar mensagens enviadas pela própria IRIS
    if (msg.key.fromMe) {
      console.log(`⏭️ [${EMPRESA_ID}] Mensagem ignorada (fromMe: true)`)
      return
    }

    // ✅ CORREÇÃO CRÍTICA: Preservar remoteJid completo (com @lid ou @s.whatsapp.net)
    const remoteJid = msg.key.remoteJid
    const isLidFormat = remoteJid.includes('@lid')
    const pushName = msg.pushName || 'Cliente'
    const messageId = msg.key.id

    let content = ''
    let type = 'text'
    let mediaBase64 = null

    try {
      if (msg.message.conversation) {
        content = msg.message.conversation
      } else if (msg.message.extendedTextMessage) {
        content = msg.message.extendedTextMessage.text
      } else if (msg.message.imageMessage) {
        type = 'image'
        content = msg.message.imageMessage.caption || ''
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) })
        mediaBase64 = `data:${msg.message.imageMessage.mimetype};base64,${buffer.toString('base64')}`
      } else if (msg.message.audioMessage) {
        type = 'audio'
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) })
        mediaBase64 = `data:${msg.message.audioMessage.mimetype};base64,${buffer.toString('base64')}`
      } else if (msg.message.videoMessage) {
        type = 'video'
        content = msg.message.videoMessage.caption || ''
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) })
        mediaBase64 = `data:${msg.message.videoMessage.mimetype};base64,${buffer.toString('base64')}`
      } else if (msg.message.documentMessage) {
        type = 'document'
        content = msg.message.documentMessage.fileName || 'Arquivo recebido'
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) })
        mediaBase64 = `data:${msg.message.documentMessage.mimetype};base64,${buffer.toString('base64')}`
      }

      console.log(`📩 [${EMPRESA_ID}] Mensagem ${isLidFormat ? '[FACEBOOK ADS @lid]' : '[WhatsApp normal]'} RECEBIDA de ${remoteJid}: ${content.substring(0, 50)} [ID: ${messageId}]`)

      // ✅ CORREÇÃO: NÃO salvar no Supabase aqui - deixar o webhook fazer isso
      // Isso evita duplicação de mensagens

      // ================================
      // 🔔 ENVIO DO WEBHOOK (CORRIGIDO)
      // ================================
      const webhookPayload = {
        from: remoteJid,  // ✅ JID COMPLETO (com @lid ou @s.whatsapp.net)
        to: `${connectionStatus.number}@s.whatsapp.net`,
        message: content,  // ✅ STRING simples
        messageId: messageId,
        name: pushName,
        type,
        media: mediaBase64,
        fromMe: false
      }

      console.log(`🔔 [${EMPRESA_ID}] Enviando para baileys-webhook-adapter com messageId: ${messageId}`)

      const bodyString = JSON.stringify(webhookPayload);
      const signature = generateWebhookSignature(bodyString, BAILEYS_WEBHOOK_SECRET);

      // ✅ CORREÇÃO: URL corrigida para baileys-webhook-adapter
      const webhookUrl = "https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook-adapter";

      console.log("📤 Chamando webhook:", webhookUrl);
      console.log("📊 Dados:", {
        isLidFormat,
        from: remoteJid,
        name: pushName,
        messagePreview: content.substring(0, 30)
      });

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Empresa-ID": EMPRESA_ID,  // ✅ Header correto
          "X-Webhook-Signature": signature
        },
        body: bodyString
      })

      if (response.ok) {
        const responseData = await response.json()
        console.log(`✅ [${EMPRESA_ID}] Webhook processado:`, responseData)
      } else {
        const errorText = await response.text()
        console.error(`⚠️ [${EMPRESA_ID}] Webhook erro ${response.status}:`, errorText)
      }

    } catch (err) {
      console.error(`❌ [${EMPRESA_ID}] Erro no recebimento:`, err.message)
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

// ================================
// 📡 ENDPOINT STATUS
// ================================
app.get('/status', (req, res) => {
  res.json({
    success: true,
    empresa_id: EMPRESA_ID,
    connected: connectionStatus.connected,
    number: connectionStatus.number,
    lastUpdate: connectionStatus.lastUpdate
  })
})

// ================================
// 📤 ENDPOINT ENVIO DE MENSAGEM
// ================================
app.post('/send-message', async (req, res) => {
  try {
    const { number, message, media, type, fileName } = req.body

    if (!sock || !connectionStatus.connected) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp não conectado.'
      })
    }

    if (!number) {
      return res.status(400).json({ success: false, error: 'Número não fornecido.' })
    }

    let jid = number
    if (!jid.includes('@')) {
      jid = `${number}@s.whatsapp.net`
    }

    console.log(`📤 [${EMPRESA_ID}] Enviando mensagem para ${jid}...`)

    let sentMsg
    if (media) {
      let mediaBuffer;

      // ✅ CORREÇÃO: Aceitar tanto base64 quanto URL
      if (media.startsWith('data:')) {
        console.log(`📦 [${EMPRESA_ID}] Media em base64, convertendo...`);
        const base64Data = media.split(',')[1];
        mediaBuffer = Buffer.from(base64Data, 'base64');
        console.log(`✅ [${EMPRESA_ID}] Conversão concluída, tamanho:`, mediaBuffer.length);
      } else if (media.startsWith('http://') || media.startsWith('https://')) {
        // ⚠️ FALLBACK: Se ainda vier URL, baixar aqui
        console.log(`⚠️ [${EMPRESA_ID}] Recebeu URL, baixando...`);
        const response = await fetch(media);
        mediaBuffer = Buffer.from(await response.arrayBuffer());
        console.log(`✅ [${EMPRESA_ID}] Download concluído, tamanho:`, mediaBuffer.length);
      } else {
        throw new Error('Media format not supported');
      }

      // Enviar com base no tipo
      if (type === 'image') {
        sentMsg = await sock.sendMessage(jid, {
          image: mediaBuffer,
          caption: message || ''
        });
      } else if (type === 'audio') {
        sentMsg = await sock.sendMessage(jid, {
          audio: mediaBuffer,
          mimetype: 'audio/mp4',
          ptt: true
        });
      } else if (type === 'video') {
        sentMsg = await sock.sendMessage(jid, {
          video: mediaBuffer,
          caption: message || ''
        });
      } else if (type === 'document') {
        // ✅ CORREÇÃO: Determinar mimetype correto
        let mimetype = 'application/pdf';
        if (fileName) {
          const ext = fileName.split('.').pop()?.toLowerCase();
          const mimeMap = {
            'pdf': 'application/pdf',
            'doc': 'application/msword',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'xls': 'application/vnd.ms-excel',
            'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          };
          mimetype = mimeMap[ext] || 'application/pdf';
        }

        sentMsg = await sock.sendMessage(jid, {
          document: mediaBuffer,
          mimetype: mimetype,
          fileName: fileName || 'arquivo.pdf'
        });

        console.log(`📎 [${EMPRESA_ID}] Documento enviado:`, fileName);
      }
    } else {
      sentMsg = await sock.sendMessage(jid, { text: message })
    }

    console.log(`✅ [${EMPRESA_ID}] Mensagem enviada com sucesso.`)

    // ✅ CORREÇÃO CRÍTICA: Removido código que tentava salvar na tabela 'chat_mensagens'
    // A tabela não existe mais. As mensagens são salvas automaticamente via webhook.
    // Linhas 306-315 do arquivo original foram removidas.

    res.json({
      success: true,
      message: 'Mensagem enviada com sucesso.',
      messageId: sentMsg?.key?.id
    })
  } catch (error) {
    console.error(`❌ [${EMPRESA_ID}] Erro ao enviar mensagem:`, error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ================================
// 🚪 ENDPOINT LOGOUT
// ================================
app.get('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout()
      connectionStatus.connected = false
      console.log(`🚪 [${EMPRESA_ID}] Sessão encerrada manualmente.`)
      return res.json({ success: true, message: 'Sessão encerrada.' })
    }
    res.status(400).json({ success: false, message: 'Nenhuma sessão ativa.' })
  } catch (err) {
    console.error(`❌ [${EMPRESA_ID}] Erro ao desconectar:`, err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ================================
// 🚀 INICIALIZA SERVIDOR
// ================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 [${EMPRESA_ID}] Servidor rodando na porta ${PORT}`)
  connectToWhatsApp()
})
