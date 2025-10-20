// ===============================
// 📱 Servidor Baileys - IRIS WhatsApp
// ===============================

import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import express from 'express'
import P from 'pino'
import fs from 'fs'
import fetch from 'node-fetch'
import ffmpeg from 'fluent-ffmpeg'
import { PassThrough } from 'stream'
import dotenv from 'dotenv'

dotenv.config()

// ===============================
// ⚙️ Variáveis de ambiente
// ===============================
const PORT = process.env.PORT || 10000
const EMPRESA_ID = process.env.EMPRESA_ID || 'credihouse'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
const BAILEYS_WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET

// ===============================
// 🧠 Inicialização Express
// ===============================
const app = express()
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

let sock

// ===============================
// 🔄 Função principal
// ===============================
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
    logger: P({ level: 'silent' })
  })

  console.log(`🟢 [${EMPRESA_ID}] Servidor rodando na porta ${PORT}`)

  // ===============================
  // 🔌 Atualização de conexão
  // ===============================
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log(`⚠️ [${EMPRESA_ID}] Conexão encerrada:`, lastDisconnect?.error?.message)
      if (shouldReconnect) {
        console.log(`♻️ [${EMPRESA_ID}] Tentando reconectar...`)
        startSock()
      } else {
        console.log(`🚫 [${EMPRESA_ID}] Sessão encerrada permanentemente.`)
      }
    } else if (connection === 'open') {
      console.log(`✅ [${EMPRESA_ID}] WhatsApp conectado com sucesso! Número: ${sock.user.id}`)
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ===============================
  // 📨 Listener - Mensagens Recebidas
  // ===============================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log(`🔔 [${EMPRESA_ID}] Evento 'messages.upsert' disparado! Total de mensagens: ${messages.length}`)

    for (const msg of messages) {
      const from = msg.key.remoteJid
      const isFromMe = msg.key.fromMe || false
      console.log(`📩 [${EMPRESA_ID}] Mensagem recebida de: ${from} | fromMe: ${isFromMe}`)

      if (isFromMe) {
        console.log(`⏭️ [${EMPRESA_ID}] Ignorando mensagem fromMe=true`)
        continue
      }

      const messageType = Object.keys(msg.message || {})[0] || 'unknown'
      const messageText =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.documentMessage?.fileName ||
        ''

      console.log(`💬 [${EMPRESA_ID}] Conteúdo recebido: "${messageText}" (tipo: ${messageType})`)

      try {
        const payload = {
          from,
          message: messageText,
          type: messageType === 'conversation' ? 'text' : messageType,
          fromMe: false
        }

        const response = await fetch(`${SUPABASE_URL}/functions/v1/baileys-webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Empresa-ID': EMPRESA_ID,
            'X-Webhook-Signature': BAILEYS_WEBHOOK_SECRET
          },
          body: JSON.stringify(payload)
        })

        console.log(`✅ [${EMPRESA_ID}] Webhook respondeu (${response.status})`)
      } catch (err) {
        console.error(`❌ [${EMPRESA_ID}] Erro ao enviar webhook:`, err.message)
      }
    }
  })

  // ===============================
  // 🧾 Endpoint - Envio de Mensagem
  // ===============================
  app.post('/send-message', async (req, res) => {
    try {
      const { number, message, media, fileName } = req.body
      const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

      if (!number) return res.status(400).json({ success: false, error: 'Número não fornecido.' })

      // ===============================
      // 📎 Envio de Documentos (PDF)
      // ===============================
      if (media && fileName && media.startsWith('https://')) {
        console.log(`[${EMPRESA_ID}] Enviando documento ${fileName}...`)
        const response = await fetch(media)
        const buffer = await response.arrayBuffer()

        await sock.sendMessage(jid, {
          document: Buffer.from(buffer),
          mimetype: 'application/pdf',
          fileName
        })

        console.log(`[${EMPRESA_ID}] Documento enviado com sucesso: ${fileName}`)
        return res.json({ success: true, message: 'Documento enviado com sucesso.' })
      }

      // ===============================
      // 🎤 Envio de Áudio Base64
      // ===============================
      if (media && media.startsWith('data:audio/')) {
        console.log(`=== AUDIO DEBUG ===`)
        console.log(`[${EMPRESA_ID}] Processando envio de áudio base64...`)

        const base64Data = media.split(',')[1] || media
        const audioBuffer = Buffer.from(base64Data, 'base64')
        console.log(`[${EMPRESA_ID}] Audio buffer size: ${audioBuffer.length} bytes`)

        const tempOggPath = `/tmp/audio-${Date.now()}.ogg`
        const tempMp3Path = `/tmp/audio-${Date.now()}.mp3`
        fs.writeFileSync(tempOggPath, audioBuffer)
        console.log(`[${EMPRESA_ID}] Temporary OGG file saved at: ${tempOggPath}`)

        try {
          console.log(`[${EMPRESA_ID}] Tentando enviar como OGG...`)
          await sock.sendMessage(jid, {
            audio: audioBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
          })
          console.log(`[${EMPRESA_ID}] ✅ Áudio OGG enviado com sucesso.`)
          fs.unlinkSync(tempOggPath)
          return res.json({ success: true, message: 'Áudio enviado com sucesso.' })
        } catch (oggError) {
          console.log(`[${EMPRESA_ID}] ⚠️ Falha ao enviar OGG, convertendo para MP3...`)

          await new Promise((resolve, reject) => {
            ffmpeg(tempOggPath)
              .toFormat('mp3')
              .on('end', resolve)
              .on('error', reject)
              .save(tempMp3Path)
          })

          const mp3Buffer = fs.readFileSync(tempMp3Path)
          console.log(`[${EMPRESA_ID}] MP3 buffer size: ${mp3Buffer.length} bytes`)

          await sock.sendMessage(jid, {
            audio: mp3Buffer,
            mimetype: 'audio/mpeg',
            ptt: true
          })
          console.log(`[${EMPRESA_ID}] ✅ Áudio MP3 enviado com sucesso.`)

          fs.unlinkSync(tempOggPath)
          fs.unlinkSync(tempMp3Path)
          return res.json({ success: true, message: 'Áudio MP3 enviado com sucesso.' })
        }
      }

      // ===============================
      // 💬 Envio de Texto
      // ===============================
      await sock.sendMessage(jid, { text: message || '' })
      console.log(`[${EMPRESA_ID}] Mensagem de texto enviada para ${jid}`)
      return res.json({ success: true, message: 'Mensagem enviada com sucesso.' })
    } catch (error) {
      console.error(`[${EMPRESA_ID}] Erro ao enviar mensagem:`, error.message)
      return res.status(500).json({ success: false, error: error.message })
    }
  })

  // ===============================
  // 🚀 Inicialização Servidor
  // ===============================
  app.listen(PORT, () => console.log(`🌐 [${EMPRESA_ID}] Servidor HTTP rodando na porta ${PORT}`))
}

startSock()
