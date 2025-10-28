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
import dotenv from 'dotenv'

dotenv.config()

// ================================
// 🔧 CONFIGURAÇÕES GERAIS
// ================================
const PORT = process.env.PORT || 10000
const EMPRESA_ID = process.env.EMPRESA_ID || 'credihouse'
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ssbuwpeasbkxobowfyvw.supabase.co"
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzYnV3cGVhc2JreG9ib3dmeXZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4NzA4MjEsImV4cCI6MjA3NTQ0NjgyMX0.plDzeNZQZEv8-3OX09VSTAUURq01zLm0PXxc2KdPAuY"
const BAILEYS_WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || "credlar-shared-secret"

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const app = express()
app.use(express.json())

let sock = null
let lastQR = null // ✅ Armazena o último QR code gerado
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
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['IRIS CRM', 'Chrome', '4.0'],
    printQRInTerminal: true // ✅ Exibe QR no terminal também
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.clear()
      console.log(`📱 [${EMPRESA_ID}] Escaneie o QR Code abaixo para conectar o WhatsApp:`)
      qrcode.generate(qr, { small: true })
      lastQR = qr // ✅ Salva QR code para o endpoint /qr
      console.log(`✅ QR Code disponível no endpoint: http://72.60.254.219:${PORT}/qr`)
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`⚠️ [${EMPRESA_ID}] Conexão encerrada:`, reason)
      connectionStatus.connected = false
      connectionStatus.number = null
      lastQR = null // ✅ Limpa o QR code ao desconectar
      
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔄 Tentando reconectar em 5 segundos...')
        setTimeout(() => connectToWhatsApp(), 5000)
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
      lastQR = null // ✅ Limpa QR code após conectar
    }
  })

  // ================================
  // 💬 RECEBIMENTO DE MENSAGENS
  // ================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    // ⚠️ CRÍTICO: Ignorar mensagens enviadas pela própria IRIS
    if (msg.key.fromMe) {
      console.log(`⏭️ [${EMPRESA_ID}] Mensagem ignorada (fromMe: true)`)
      return
    }

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

      console.log(`📩 [${EMPRESA_ID}] Mensagem (${type}) RECEBIDA de ${sender}: ${content}`)

      await supabase.from('chat_mensagens').insert([
        { 
          remetente: sender, 
          mensagem: content, 
          tipo: type, 
          data_envio: new Date(), 
          empresa_id: EMPRESA_ID 
        }
      ])

      // ================================
      // 🔔 ENVIO DO WEBHOOK
      // ================================
      const webhookPayload = {
        from: sender,
        to: `${connectionStatus.number}@s.whatsapp.net`,
        message: content,
        name: pushName,
        type,
        media: mediaBase64,
        fromMe: false
      }

      console.log(`🔔 [${EMPRESA_ID}] Enviando webhook...`)

      const response = await fetch(`${SUPABASE_URL}/functions/v1/baileys-webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Empresa-ID": EMPRESA_ID,
          "X-Webhook-Signature": BAILEYS_WEBHOOK_SECRET
        },
        body: JSON.stringify(webhookPayload)
      })

      if (response.ok) {
        const responseData = await response.json()
        console.log(`✅ [${EMPRESA_ID}] Webhook processado:`, responseData)
      } else {
        console.error(`⚠️ [${EMPRESA_ID}] Webhook erro ${response.status}:`, await response.text())
      }

    } catch (err) {
      console.error(`❌ [${EMPRESA_ID}] Erro no recebimento:`, err.message)
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

// ================================
// 📡 ENDPOINTS DA API
// ================================

// Status da conexão
app.get('/status', (req, res) => {
  res.json({
    success: true,
    empresa_id: EMPRESA_ID,
    connected: connectionStatus.connected,
    number: connectionStatus.number,
    lastUpdate: connectionStatus.lastUpdate,
    hasQR: !!lastQR
  })
})

// ✅ ENDPOINT PRINCIPAL: Retorna QR Code
app.get('/qr', (req, res) => {
  if (lastQR) {
    res.json({ 
      success: true, 
      qr: lastQR,
      message: 'QR code disponível' 
    })
  } else if (connectionStatus.connected) {
    res.json({ 
      success: false, 
      message: 'WhatsApp já está conectado' 
    })
  } else {
    res.json({ 
      success: false, 
      message: 'QR code ainda não foi gerado. Aguarde a conexão iniciar...' 
    })
  }
})

// Enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    const { number, message, type, media } = req.body
    
    if (!number) {
      return res.status(400).json({ success: false, error: 'Número é obrigatório.' })
    }

    if (!connectionStatus.connected) {
      return res.status(400).json({ success: false, error: 'WhatsApp não está conectado.' })
    }

    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`
    let sentMsg = null

    console.log(`📤 [${EMPRESA_ID}] Enviando mensagem para ${jid}: ${message || '(mídia)'}`)

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
      }
    } else {
      sentMsg = await sock.sendMessage(jid, { text: message })
    }

    console.log(`✅ [${EMPRESA_ID}] Mensagem enviada com sucesso.`)

    await supabase.from('chat_mensagens').insert([
      {
        remetente: connectionStatus.number,
        destinatario: number,
        mensagem: message || '(mídia)',
        tipo: type || 'text',
        data_envio: new Date(),
        empresa_id: EMPRESA_ID
      }
    ])

    res.json({ success: true, message: 'Mensagem enviada com sucesso.' })
  } catch (error) {
    console.error(`❌ [${EMPRESA_ID}] Erro ao enviar mensagem:`, error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Logout
app.get('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout()
      connectionStatus.connected = false
      lastQR = null
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
  console.log(`🌐 [${EMPRESA_ID}] Servidor Baileys rodando na porta ${PORT}`)
  console.log(`📡 Status: http://72.60.254.219:${PORT}/status`)
  console.log(`📱 QR Code: http://72.60.254.219:${PORT}/qr`)
  connectToWhatsApp()
})
