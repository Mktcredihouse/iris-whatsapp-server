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
import { PassThrough } from 'stream'

dotenv.config()

const PORT = process.env.PORT || 10000
const EMPRESA_ID = process.env.EMPRESA_ID || 'empresa-desconhecida'
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
// ✉️ ENVIO DE MENSAGEM (DEBUG DE ÁUDIO)
// ================================
app.post('/send-message', async (req, res) => {
  try {
    const { number, message, type, media, fileName } = req.body
    if (!number) return res.status(400).json({ success: false, error: 'Número é obrigatório.' })

    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

    // 🎧 DEBUG DE ÁUDIO
    if (media && media.startsWith('data:audio/')) {
      console.log('=== AUDIO DEBUG ===')
      const base64Data = media.split(',')[1] || media
      console.log('Base64 length:', base64Data.length)

      const audioBuffer = Buffer.from(base64Data, 'base64')
      console.log('Audio buffer size:', audioBuffer.length, 'bytes')
      if (audioBuffer.length === 0) throw new Error('Audio buffer is empty')

      const tempFile = `/tmp/audio-${Date.now()}.ogg`
      fs.writeFileSync(tempFile, audioBuffer)
      console.log('Audio saved to:', tempFile)

      try {
        console.log('Attempting to send as OGG/Opus...')
        await sock.sendMessage(jid, {
          audio: audioBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        })
        console.log('✅ Audio sent successfully as OGG')
      } catch (error) {
        console.log('❌ Failed to send as OGG:', error.message)
        console.log('Converting to MP3...')

        const outputPath = `/tmp/audio-${Date.now()}.mp3`
        await new Promise((resolve, reject) => {
          ffmpeg(tempFile)
            .toFormat('mp3')
            .on('end', () => {
              console.log('✅ Conversion to MP3 complete')
              resolve()
            })
            .on('error', (err) => {
              console.log('❌ Conversion failed:', err.message)
              reject(err)
            })
            .save(outputPath)
        })

        const mp3Buffer = fs.readFileSync(outputPath)
        console.log('MP3 buffer size:', mp3Buffer.length, 'bytes')

        await sock.sendMessage(jid, {
          audio: mp3Buffer,
          mimetype: 'audio/mpeg',
          ptt: true
        })
        console.log('✅ Audio sent successfully as MP3')

        fs.unlinkSync(tempFile)
        fs.unlinkSync(outputPath)
      }

      console.log('=== END AUDIO DEBUG ===')
      return res.json({ success: true, message: 'Áudio processado (veja logs).' })
    }

    // Outras mídias e textos
    if (media && fileName) {
      const response = await fetch(media)
      const buffer = await response.arrayBuffer()
      await sock.sendMessage(jid, {
        document: Buffer.from(buffer),
        mimetype: 'application/pdf',
        fileName: fileName
      })
      return res.json({ success: true, message: 'Arquivo enviado com sucesso.' })
    } else {
      await sock.sendMessage(jid, { text: message })
      return res.json({ success: true, message: 'Mensagem enviada com sucesso.' })
    }
  } catch (error) {
    console.error('❌ Erro geral:', error)
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
