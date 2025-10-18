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
import ffmpeg from 'fluent-ffmpeg'
import { PassThrough } from 'stream'

dotenv.config()

// ================================
// 🔧 CONFIGURAÇÕES GERAIS
// ================================
const PORT = process.env.PORT || 10000
const EMPRESA_ID = process.env.EMPRESA_ID || 'empresa-desconhecida'
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ssbuwpeasbkxobowfyvw.supabase.co"
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
const BAILEYS_WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || "credlar-shared-secret"

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const app = express()

// ✅ Corrige erro "PayloadTooLargeError" ao enviar áudio ou mídia
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
// ✉️ ENDPOINT ENVIO DE MENSAGEM (FINAL COM ÁUDIO REVISADO)
// ================================
app.post('/send-message', async (req, res) => {
  try {
    const { number, message, type, media, fileName } = req.body
    if (!number) return res.status(400).json({ success: false, error: 'Número é obrigatório.' })

    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`
    console.log(`📤 [${EMPRESA_ID}] Enviando mensagem (${type || 'text'}) para ${jid}`)

    // ================================
    // 🎧 Envio de ÁUDIO BASE64 (data:audio/...)
    // ================================
    if (media && media.startsWith('data:audio/')) {
      console.log(`🎙️ [${EMPRESA_ID}] Processando envio de áudio base64...`)

      // 1️⃣ Extrair base64 puro
      const base64Data = media.split(',')[1] || media
      const audioBuffer = Buffer.from(base64Data, 'base64')

      console.log(`[${EMPRESA_ID}] Audio buffer size: ${audioBuffer.length} bytes`)
      if (audioBuffer.length === 0) throw new Error('Audio buffer is empty')

      try {
        // 2️⃣ Tentar enviar como OGG/Opus (nativo do WhatsApp)
        await sock.sendMessage(jid, {
          audio: audioBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        })
        console.log(`✅ [${EMPRESA_ID}] Áudio enviado com sucesso em formato OGG.`)
      } catch (err) {
        console.warn(`⚠️ [${EMPRESA_ID}] Erro ao enviar áudio OGG, tentando converter para MP3...`)

        // 3️⃣ Converter para MP3 se OGG falhar
        const convertedBuffer = await new Promise((resolve, reject) => {
          const stream = new PassThrough()
          stream.end(audioBuffer)

          const chunks = []
          ffmpeg(stream)
            .toFormat('mp3')
            .audioBitrate(128)
            .on('error', reject)
            .on('end', () => resolve(Buffer.concat(chunks)))
            .pipe()
            .on('data', chunk => chunks.push(chunk))
        })

        await sock.sendMessage(jid, {
          audio: convertedBuffer,
          mimetype: 'audio/mpeg',
          ptt: true
        })

        console.log(`✅ [${EMPRESA_ID}] Áudio convertido e enviado como MP3.`)
      }

      // 4️⃣ Webhook de confirmação
      await fetch("https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Empresa-ID": EMPRESA_ID,
          "X-Webhook-Signature": BAILEYS_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          from: connectionStatus.number,
          to: number,
          message: message || 'Áudio',
          type: 'audio',
          media: null,
          fromMe: true
        })
      })

      return res.json({ success: true, message: 'Áudio enviado com sucesso.' })
    }

    // ================================
    // 📎 Envio de DOCUMENTO (PDF)
    // ================================
    if (media && fileName) {
      const response = await fetch(media)
      const buffer = await response.arrayBuffer()

      await sock.sendMessage(jid, {
        document: Buffer.from(buffer),
        mimetype: 'application/pdf',
        fileName: fileName
      })

      await fetch("https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Empresa-ID": EMPRESA_ID,
          "X-Webhook-Signature": BAILEYS_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          from: connectionStatus.number,
          to: number,
          message: `Arquivo: ${fileName}`,
          type: "document",
          media: media,
          fromMe: true,
          fileName: fileName
        })
      })

      return res.json({ success: true, message: 'Arquivo enviado com sucesso.' })
    }

    // ================================
    // 🖼️ Envio de IMAGEM
    // ================================
    if (media && type === 'image') {
      const response = await fetch(media)
      const buffer = await response.arrayBuffer()
      await sock.sendMessage(jid, {
        image: Buffer.from(buffer),
        caption: message || ''
      })
    }

    // ================================
    // 🎥 Envio de VÍDEO
    // ================================
    else if (media && type === 'video') {
      const response = await fetch(media)
      const buffer = await response.arrayBuffer()
      await sock.sendMessage(jid, {
        video: Buffer.from(buffer),
        caption: message || ''
      })
    }

    // ================================
    // 💬 Mensagem de TEXTO
    // ================================
    else {
      await sock.sendMessage(jid, { text: message })
    }

    console.log(`✅ [${EMPRESA_ID}] Mensagem enviada com sucesso.`)

    await fetch("https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Empresa-ID": EMPRESA_ID,
        "X-Webhook-Signature": BAILEYS_WEBHOOK_SECRET
      },
      body: JSON.stringify({
        from: connectionStatus.number,
        to: number,
        message: message,
        type: type || 'text',
        media: media || null,
        fromMe: true
      })
    })

    res.json({ success: true, message: 'Mensagem enviada com sucesso.' })
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
      return res.json({ success: true, message: 'Sessão encerrada.' })
    }
    res.status(400).json({ success: false, message: 'Nenhuma sessão ativa.' })
  } catch (err) {
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
