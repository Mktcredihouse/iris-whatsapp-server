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

let connectionStatus = {
  connected: false,
  number: null,
  lastUpdate: null
}

// =====================================================
// 🔐 FUNÇÃO PRINCIPAL
// =====================================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['IRIS CRM', 'Chrome', '4.0']
  })

  console.log(`🟢 [${EMPRESA_ID}] Socket Baileys iniciado... aguardando eventos.`)

  // =====================================================
  // 🧩 FIX — LISTENER DIRETO PARA MENSAGENS
  // =====================================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log(`🔔 [${EMPRESA_ID}] Evento messages.upsert disparado! Total: ${messages.length}`)

    for (const msg of messages) {
      console.log(`📬 [${EMPRESA_ID}] Mensagem recebida bruta:`, JSON.stringify(msg, null, 2))
      try {
        if (msg.key.fromMe) {
          console.log(`⏭️ [${EMPRESA_ID}] Ignorando mensagem enviada pelo sistema`)
          continue
        }

        const from = msg.key.remoteJid
        const messageType = Object.keys(msg.message || {})[0] || 'unknown'
        const messageText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.documentMessage?.fileName ||
          ''

        console.log(`📩 [${EMPRESA_ID}] Mensagem recebida de ${from}: ${messageText}`)

        const payload = {
          from,
          message: messageText,
          type: messageType === 'conversation' ? 'text' : messageType,
          fromMe: false
        }

        console.log(`🚀 [${EMPRESA_ID}] Enviando webhook:`)
        const response = await fetch(`${SUPABASE_URL}/functions/v1/baileys-webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Empresa-ID': EMPRESA_ID,
            'X-Webhook-Signature': BAILEYS_WEBHOOK_SECRET
          },
          body: JSON.stringify(payload)
        })
        console.log(`✅ [${EMPRESA_ID}] Webhook respondeu: ${response.status}`)
      } catch (err) {
        console.error(`❌ [${EMPRESA_ID}] Erro ao processar mensagem recebida:`, err.message)
      }
    }
  })

  // =====================================================
  // 🔌 EVENTOS DE CONEXÃO
  // =====================================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.clear()
      console.log(`📱 [${EMPRESA_ID}] Escaneie o QR Code abaixo:`)
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      const user = sock?.user?.id?.split(':')[0]
      console.log(`✅ [${EMPRESA_ID}] WhatsApp conectado! Número: ${user}`)
      connectionStatus = {
        connected: true,
        number: user,
        lastUpdate: new Date().toISOString()
      }
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`⚠️ [${EMPRESA_ID}] Conexão encerrada:`, reason)
      connectionStatus.connected = false
      if (reason !== DisconnectReason.loggedOut) connectToWhatsApp()
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

// =====================================================
// 📡 STATUS
// =====================================================
app.get('/status', (req, res) => {
  res.json({
    success: true,
    empresa_id: EMPRESA_ID,
    connected: connectionStatus.connected,
    number: connectionStatus.number,
    lastUpdate: connectionStatus.lastUpdate
  })
})

// =====================================================
// ✉️ ENVIO DE MENSAGEM / ÁUDIO / PDF
// =====================================================
app.post('/send-message', async (req, res) => {
  try {
    const { number, message, media, fileName } = req.body
    if (!number) return res.status(400).json({ success: false, error: 'Número é obrigatório.' })

    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

    // 🎧 ÁUDIO
    if (media && media.startsWith('data:audio/')) {
      console.log(`=== AUDIO DEBUG ===`)
      const base64Data = media.split(',')[1] || media
      const audioBuffer = Buffer.from(base64Data, 'base64')
      console.log(`[${EMPRESA_ID}] Audio buffer size: ${audioBuffer.length} bytes`)

      const tempOgg = `/tmp/audio-${Date.now()}.ogg`
      const tempMp3 = `/tmp/audio-${Date.now()}.mp3`
      fs.writeFileSync(tempOgg, audioBuffer)

      try {
        await sock.sendMessage(jid, {
          audio: audioBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        })
        console.log(`[${EMPRESA_ID}] ✅ Áudio enviado (OGG)`)
        fs.unlinkSync(tempOgg)
        return res.json({ success: true })
      } catch (e) {
        console.log(`[${EMPRESA_ID}] ⚠️ Erro OGG, convertendo para MP3...`)
        await new Promise((resolve, reject) => {
          ffmpeg(tempOgg)
            .toFormat('mp3')
            .audioCodec('libmp3lame')
            .audioBitrate('128k')
            .on('end', resolve)
            .on('error', reject)
            .save(tempMp3)
        })
        const mp3Buffer = fs.readFileSync(tempMp3)
        await sock.sendMessage(jid, { audio: mp3Buffer, mimetype: 'audio/mpeg', ptt: true })
        fs.unlinkSync(tempOgg)
        fs.unlinkSync(tempMp3)
        console.log(`[${EMPRESA_ID}] ✅ Áudio enviado (MP3)`)
        return res.json({ success: true })
      }
    }

    // 📎 PDF
    if (media && fileName) {
      const response = await fetch(media)
      const buffer = await response.arrayBuffer()
      await sock.sendMessage(jid, {
        document: Buffer.from(buffer),
        mimetype: 'application/pdf',
        fileName
      })
      console.log(`[${EMPRESA_ID}] ✅ PDF enviado: ${fileName}`)
      return res.json({ success: true })
    }

    // 💬 TEXTO
    await sock.sendMessage(jid, { text: message })
    console.log(`[${EMPRESA_ID}] ✅ Mensagem enviada para ${jid}`)
    return res.json({ success: true })
  } catch (error) {
    console.error(`❌ Erro no envio:`, error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// =====================================================
// 🚀 START SERVIDOR
// =====================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 [${EMPRESA_ID}] Servidor rodando na porta ${PORT}`)
  connectToWhatsApp()
})
