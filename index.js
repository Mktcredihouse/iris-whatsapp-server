import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage
} from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'
import P from 'pino'
import express from 'express'
import qrcode from 'qrcode-terminal'
import { Boom } from '@hapi/boom'
import fetch from 'node-fetch'

// ================================
// 🔧 CONFIGURAÇÕES GERAIS
// ================================
const PORT = process.env.PORT || 10000
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ssbuwpeasbkxobowfyvw.supabase.co"
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzYnV3cGVhc2JreG9ib3dmeXZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4NzA4MjEsImV4cCI6MjA3NTQ0NjgyMX0.plDzeNZQZEv8-3OX09VSTAUURq01zLm0PXxc2KdPAuY"

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const app = express()
app.use(express.json())

let sock = null
let connectionStatus = {
  connected: false,
  number: null,
  lastUpdate: null
}

// ================================
// 🔐 CONEXÃO COM WHATSAPP
// ================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['IRIS CRM', 'Chrome', '4.0']
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.clear()
      console.log('📱 Escaneie o QR Code abaixo para conectar o WhatsApp:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log('⚠️ Conexão encerrada:', reason)
      connectionStatus.connected = false
      connectionStatus.number = null
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔄 Tentando reconectar...')
        connectToWhatsApp()
      }
    }

    if (connection === 'open') {
      const user = sock?.user?.id?.split(':')[0]
      console.log(`✅ WhatsApp conectado com sucesso! Número: ${user}`)
      connectionStatus = {
        connected: true,
        number: user,
        lastUpdate: new Date().toISOString()
      }
    }
  })

  // ================================
  // 💬 RECEBIMENTO DE MENSAGENS (TEXTO + MÍDIA)
  // ================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    const sender = msg.key.remoteJid
    const pushName = msg.pushName || 'Cliente'
    let content = ''
    let type = 'text'
    let mediaBase64 = null

    try {
      // Tipo da mensagem
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

      console.log(`📩 Mensagem (${type}) recebida de ${sender}: ${content}`)

      // Salva no Supabase
      await supabase.from('chat_mensagens').insert([
        { remetente: sender, mensagem: content, tipo: type, data_envio: new Date() }
      ])

      // Envia para Lovable Webhook
      const response = await fetch("https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({
          from: sender,
          message: content,
          name: pushName,
          type,
          media: mediaBase64
        })
      })

      if (response.ok) console.log("📨 Webhook Lovable notificado com sucesso.")
      else console.error(`⚠️ Webhook Lovable respondeu: ${response.status}`)
    } catch (err) {
      console.error("❌ Erro no recebimento:", err.message)
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
    connected: connectionStatus.connected,
    number: connectionStatus.number,
    lastUpdate: connectionStatus.lastUpdate,
    timestamp: new Date().toISOString()
  })
})

// ================================
// ✉️ ENDPOINT ENVIO DE MENSAGEM/MÍDIA
// ================================
app.post('/send-message', async (req, res) => {
  try {
    const { number, message, type, media } = req.body
    if (!number) return res.status(400).json({ success: false, error: 'Número é obrigatório.' })

    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`
    let sentMsg = null

    console.log(`📤 Enviando mensagem para ${jid}: ${message || '(mídia)'}`)

    // Se for mídia
    if (media && type) {
      const mediaBuffer = Buffer.from(media.split(',')[1], 'base64')

      if (type === 'image') {
        sentMsg = await sock.sendMessage(jid, { image: mediaBuffer, caption: message || '' })
      } else if (type === 'audio') {
        sentMsg = await sock.sendMessage(jid, { audio: mediaBuffer, mimetype: 'audio/mp4', ptt: true })
      } else if (type === 'video') {
        sentMsg = await sock.sendMessage(jid, { video: mediaBuffer, caption: message || '' })
      } else if (type === 'document') {
        sentMsg = await sock.sendMessage(jid, {
          document: mediaBuffer,
          mimetype: 'application/pdf',
          fileName: message || 'arquivo.pdf'
        })
      } else {
        sentMsg = await sock.sendMessage(jid, { text: message })
      }
    } else {
      // Texto simples
      sentMsg = await sock.sendMessage(jid, { text: message })
    }

    console.log('✅ Mensagem enviada com sucesso.')

    await supabase.from('chat_mensagens').insert([
      {
        remetente: connectionStatus.number,
        destinatario: number,
        mensagem: message || '(mídia)',
        tipo: type || 'text',
        data_envio: new Date()
      }
    ])

    res.json({ success: true, message: 'Mensagem enviada com sucesso.' })
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Compatibilidade com endpoint antigo /send
app.post('/send', async (req, res) => {
  req.url = '/send-message'
  app._router.handle(req, res)
})

// ================================
// 🚪 ENDPOINT LOGOUT
// ================================
app.get('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout()
      connectionStatus.connected = false
      console.log('🚪 Sessão encerrada manualmente.')
      return res.json({ success: true, message: 'Sessão encerrada.' })
    }
    res.status(400).json({ success: false, message: 'Nenhuma sessão ativa.' })
  } catch (err) {
    console.error('❌ Erro ao desconectar:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ================================
// 🚀 INICIALIZA SERVIDOR
// ================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`)
  connectToWhatsApp()
})
