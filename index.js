// ===============================
// IRIS WHATSAPP SERVER - v1.6.2
// ===============================

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys'
import express from 'express'
import fetch from 'node-fetch'
import fs from 'fs'
import ffmpeg from 'fluent-ffmpeg'
import P from 'pino'
import cors from 'cors'

// ===============================
// CONFIGURAÇÕES GERAIS
// ===============================

const PORT = process.env.PORT || 10000
const EMPRESA_ID = 'Credihouse' // <--- Altere aqui se for Sorocaba
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ssbuwpeasbkxobowfyvw.supabase.co'
const BAILEYS_WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || 'credlar-shared-secret'

const app = express()
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))
app.use(cors())

// ===============================
// FUNÇÃO PRINCIPAL DE CONEXÃO
// ===============================

async function iniciarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
    },
    printQRInTerminal: true,
    browser: ['Credihouse Iris', 'Chrome', '10.0'],
    logger: P({ level: 'info' }),
  })

  // Salva credenciais a cada mudança
  sock.ev.on('creds.update', saveCreds)

  // Listener de atualização de conexão
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      if (reason === DisconnectReason.loggedOut) {
        console.log(`[${EMPRESA_ID}] Sessão encerrada permanentemente.`)
        fs.rmSync('./session', { recursive: true, force: true })
      } else {
        console.log(`[${EMPRESA_ID}] Conexão encerrada. Tentando reconectar...`)
        setTimeout(() => iniciarWhatsApp(), 5000)
      }
    } else if (connection === 'open') {
      console.log(`✅ [${EMPRESA_ID}] WhatsApp conectado com sucesso! Número: ${sock.user.id}`)
    }
  })

  // ===============================
  // LISTENER DE MENSAGENS RECEBIDAS
  // ===============================

  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log(`🔔 [${EMPRESA_ID}] messages.upsert disparado! Total de mensagens: ${messages.length}`)

    for (const msg of messages) {
      try {
        const remoteJid = msg.key.remoteJid
        const fromMe = msg.key.fromMe || false
        const messageType = Object.keys(msg.message || {})[0]
        const messageText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.documentMessage?.fileName ||
          ''

        console.log(`📋 [${EMPRESA_ID}] Mensagem detectada:`, {
          fromMe,
          remoteJid,
          messageType,
          messageText,
        })

        // Ignora mensagens enviadas pelo próprio sistema
        if (fromMe) {
          console.log(`⏭️ [${EMPRESA_ID}] Ignorando mensagem enviada pelo sistema (fromMe=true)`)
          continue
        }

        // Envia webhook
        const payload = {
          from: remoteJid,
          message: messageText,
          type: messageType === 'conversation' ? 'text' : messageType,
          fromMe: false,
        }

        console.log(`🚀 [${EMPRESA_ID}] Enviando payload ao webhook:`, payload)

        const response = await fetch(`${SUPABASE_URL}/functions/v1/baileys-webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Empresa-ID': EMPRESA_ID,
            'X-Webhook-Signature': BAILEYS_WEBHOOK_SECRET,
          },
          body: JSON.stringify(payload),
        })

        const resText = await response.text()
        console.log(`✅ [${EMPRESA_ID}] Webhook respondeu (${response.status}): ${resText}`)
      } catch (err) {
        console.error(`❌ [${EMPRESA_ID}] Erro ao processar mensagem:`, err.message)
      }
    }
  })

  // ===============================
  // ENDPOINTS EXPRESS
  // ===============================

  app.get('/status', async (req, res) => {
    res.json({
      success: true,
      empresa_id: EMPRESA_ID,
      connected: !!sock.user,
      number: sock.user?.id || null,
      lastUpdate: new Date().toISOString(),
    })
  })

  // Envio de mensagens (texto, áudio, PDF)
  app.post('/send-message', async (req, res) => {
    try {
      const { number, message, media, fileName } = req.body
      const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

      if (media && media.startsWith('data:audio/')) {
        console.log(`[${EMPRESA_ID}] Processando envio de áudio base64...`)
        const base64Data = media.split(',')[1] || media
        const audioBuffer = Buffer.from(base64Data, 'base64')

        console.log(`[${EMPRESA_ID}] Audio buffer size: ${audioBuffer.length} bytes`)

        await sock.sendMessage(jid, {
          audio: audioBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        })

        console.log(`[${EMPRESA_ID}] Áudio enviado com sucesso`)
        return res.json({ success: true })
      }

      if (media && fileName) {
        const response = await fetch(media)
        const buffer = await response.buffer()

        await sock.sendMessage(jid, {
          document: buffer,
          fileName: fileName,
          mimetype: 'application/pdf',
        })

        console.log(`[${EMPRESA_ID}] PDF enviado com sucesso`)
        return res.json({ success: true })
      }

      // Texto comum
      await sock.sendMessage(jid, { text: message })
      console.log(`[${EMPRESA_ID}] Mensagem enviada com sucesso para ${jid}`)
      res.json({ success: true })
    } catch (error) {
      console.error(`[${EMPRESA_ID}] Erro ao enviar mensagem:`, error.message)
      res.status(500).json({ success: false, error: error.message })
    }
  })

  app.listen(PORT, () => {
    console.log(`🌐 [${EMPRESA_ID}] Servidor rodando na porta ${PORT}`)
  })
}

// Iniciar
iniciarWhatsApp().catch((err) => console.error('Erro na inicialização:', err))
