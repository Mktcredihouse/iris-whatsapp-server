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
import os from 'os'

// ================================
// 🔧 CONFIGURAÇÕES GERAIS
// ================================
const PORT = process.env.PORT || 10000
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ssbuwpeasbkxobowfyvw.supabase.co'
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzYnV3cGVhc2JreG9ib3dmeXZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4NzA4MjEsImV4cCI6MjA3NTQ0NjgyMX0.plDzeNZQZEv8-3OX09VSTAUURq01zLm0PXxc2KdPAuY'

// ================================
// 🔌 SUPABASE + EXPRESS
// ================================
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const app = express()
app.use(express.json())

// CORS simples (Edge/Browser)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

// ================================
// 🔐 ESTADO GLOBAL
// ================================
let sock = null
const startedAt = Date.now()
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
      connectionStatus.lastUpdate = new Date().toISOString()
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
    const msg = messages?.[0]
    if (!msg || !msg.message) return

    const sender = msg.key.remoteJid
    const pushName = msg.pushName || 'Cliente'
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

      console.log(`📩 Mensagem (${type}) recebida de ${sender}: ${content}`)

      await supabase.from('chat_mensagens').insert([
        { remetente: sender, mensagem: content || '(mídia)', tipo: type, data_envio: new Date() }
      ])

      const response = await fetch(`${SUPABASE_URL}/functions/v1/baileys-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({ from: sender, message: content, name: pushName, type, media: mediaBase64 })
      })

      if (response.ok) console.log('📨 Webhook Lovable notificado com sucesso.')
      else console.error(`⚠️ Webhook Lovable respondeu: ${response.status}`)
    } catch (err) {
      console.error('❌ Erro no recebimento:', err?.message || err)
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

// ================================
// 📡 ENDPOINTS DE SAÚDE/STATUS (sem auth)
// ================================
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime_ms: Date.now() - startedAt })
})

app.get('/status', (_req, res) => {
  res.json({
    success: true,
    is_connected: !!connectionStatus.connected,
    number: connectionStatus.number,
    lastUpdate: connectionStatus.lastUpdate,
    server: { host: os.hostname(), port: Number(PORT), uptime_ms: Date.now() - startedAt },
    version: 'iris-whatsapp-server/1.1.0'
  })
})

// ================================
// ✉️ ENDPOINT ENVIO DE MENSAGEM/MÍDIA
// ================================
app.post('/send-message', async (req, res) => {
  try {
    let { number, message, type, media } = req.body
    if (!number) return res.status(400).json({ success: false, error: 'Número é obrigatório.' })

    const jid = number.includes('@s.whatsapp.net')
      ? number
      : `${String(number).replace(/\D/g, '')}@s.whatsapp.net`

    let sentMsg = null
    console.log(`📤 Enviando para ${jid}: ${message || '(mídia)'}`)

    if (media && type) {
      const mediaBuffer = Buffer.from(String(media).split(',')?.[1] || '', 'base64')
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
      sentMsg = await sock.sendMessage(jid, { text: message })
    }

    await supabase.from('chat_mensagens').insert([{
      remetente: connectionStatus.number,
      destinatario: jid,
      mensagem: message || '(mídia)',
      tipo: type || 'text',
      data_envio: new Date()
    }])

    res.json({ success: true, message: 'Mensagem enviada com sucesso.', id: sentMsg?.key?.id || null })
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error?.message || error)
    res.status(500).json({ success: false, error: String(error?.message || error) })
  }
})

// Compat com endpoint antigo /send
app.post('/send', async (req, res) => {
  req.url = '/send-message'
  app._router.handle(req, res)
})

// ================================
// 🚪 ENDPOINT LOGOUT
// ================================
app.get('/logout', async (_req, res) => {
  try {
    if (sock) {
      await sock.logout()
      connectionStatus.connected = false
      connectionStatus.number = null
      connectionStatus.lastUpdate = new Date().toISOString()
      console.log('🚪 Sessão encerrada manualmente.')
      return res.json({ success: true, message: 'Sessão encerrada.' })
    }
    res.status(400).json({ success: false, message: 'Nenhuma sessão ativa.' })
  } catch (err) {
    console.error('❌ Erro ao desconectar:', err?.message || err)
    res.status(500).json({ success: false, error: String(err?.message || err) })
  }
})

// ================================
// 🚀 INICIALIZA SERVIDOR
// ================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`)
  connectToWhatsApp()
})
