import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'
import P from 'pino'
import express from 'express'
import qrcode from 'qrcode-terminal'
import { Boom } from '@hapi/boom'
import fetch from 'node-fetch'
import dotenv from 'dotenv'
import fs from 'fs'
import ffmpeg from 'fluent-ffmpeg'

dotenv.config()

const PORT = process.env.PORT || 10000
const EMPRESA_ID = process.env.EMPRESA_ID || 'credihouse'
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ssbuwpeasbkxobowfyvw.supabase.co"
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
const BAILEYS_WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || "credlar-shared-secret"

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const app = express()
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

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

  // 🔔 Listener de conexão
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      console.clear()
      console.log(`📱 [${EMPRESA_ID}] Escaneie o QR Code abaixo:`)
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`⚠️ [${EMPRESA_ID}] Conexão encerrada:`, reason)
      connectionStatus.connected = false
      if (reason !== DisconnectReason.loggedOut) connectToWhatsApp()
    }
    if (connection === 'open') {
      const user = sock?.user?.id?.split(':')[0]
      console.log(`✅ [${EMPRESA_ID}] Conectado! Número: ${user}`)
      connectionStatus = {
        connected: true,
        number: user,
        lastUpdate: new Date().toISOString()
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ================================
  // 📥 LISTENER DE MENSAGENS RECEBIDAS
  // ================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        // Ignora mensagens enviadas por você mesmo
        if (msg.key.fromMe) continue

        const from = msg.key.remoteJid
        const messageType = Object.keys(msg.message || {})[0] || 'unknown'
        const messageText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.documentMessage?.fileName ||
          ''

        console.log(`📩 [${EMPRESA_ID}] Mensagem recebida de ${from}:`, messageText)

        // Enviar para o webhook Supabase
        await fetch(`${SUPABASE_URL}/functions/v1/baileys-webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Empresa-ID': EMPRESA_ID,
            'X-Webhook-Signature': BAILEYS_WEBHOOK_SECRET
          },
          body: JSON.stringify({
            from: from,
            message: messageText,
            type: messageType === 'conversation' ? 'text' : messageType,
            fromMe: false
          })
        })
      } catch (err) {
        console.error('❌ Erro ao processar mensagem recebida:', err)
      }
    }
  })
}

// ================================
// 📡 STATUS
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
// ✉️ ENVIO DE MENSAGEM
// ================================
app.post('/send-message', async (req, res) => {
  try {
    const { number, message, media, fileName } = req.body
    if (!number) return res.status(400).json({ success: false, error: 'Número é obrigatório.' })

    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

    // ÁUDIO
    if (media && media.startsWith('data:audio/')) {
      console.log(`[${EMPRESA_ID}] Processando envio de áudio base64...`)
      const base64Data = media.split(',')[1] || media
      const audioBuffer = Buffer.from(base64Data, 'base64')
      console.log(`[${EMPRESA_ID}] Áudio convertido (${audioBuffer.length} bytes)`)

      await sock.sendMessage(jid, {
        audio: audioBuffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true
      })
      console.log(`[${EMPRESA_ID}] Áudio enviado com sucesso.`)
      return res.json({ success: true, message: 'Áudio enviado com sucesso.' })
    }

    // PDF
    if (media && fileName) {
      const response = await fetch(media)
      const buffer = await response.arrayBuffer()
      await sock.sendMessage(jid, {
        document: Buffer.from(buffer),
        mimetype: 'application/pdf',
        fileName
      })
      console.log(`[${EMPRESA_ID}] PDF enviado: ${fileName}`)
      return res.json({ success: true, message: 'PDF enviado com sucesso.' })
    }

    // TEXTO
    await sock.sendMessage(jid, { text: message })
    console.log(`[${EMPRESA_ID}] Mensagem de texto enviada para ${jid}`)
    return res.json({ success: true, message: 'Mensagem enviada com sucesso.' })
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ================================
// 🚀 START
// ================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 [${EMPRESA_ID}] Servidor rodando na porta ${PORT}`)
  connectToWhatsApp()
})
