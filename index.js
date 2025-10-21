// ===============================
// IRIS WHATSAPP SERVER - v2.0 (ES MODULES + SUPABASE)
// ===============================

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys'
import express from 'express'
import fetch from 'node-fetch'
import fs from 'fs'
import P from 'pino'
import cors from 'cors'
import 'dotenv/config'

// ===============================
// CONFIGURAÇÕES GERAIS
// ===============================

const PORT = process.env.PORT || 10000
const EMPRESA_ID = process.env.EMPRESA_ID || 'Credihouse'
const SUPABASE_URL = process.env.SUPABASE_URL
const WEBHOOK_URL = process.env.WEBHOOK_URL
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET

if (!SUPABASE_URL || !WEBHOOK_URL) {
  console.error('❌ Variáveis de ambiente ausentes! Verifique o arquivo .env')
  process.exit(1)
}

const app = express()
app.use(express.json({ limit: '50mb' }))
app.use(cors())

// ===============================
// FUNÇÃO PRINCIPAL
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

  sock.ev.on('creds.update', saveCreds)

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
      console.log(`✅ [${EMPRESA_ID}] WhatsApp conectado com sucesso!`)
      registrarListener(sock)
    }
  })

  app.get('/status', async (req, res) => {
    res.json({
      success: true,
      empresa_id: EMPRESA_ID,
      connected: !!sock.user,
      number: sock.user?.id || null,
      lastUpdate: new Date().toISOString(),
    })
  })

  app.post('/send-message', async (req, res) => {
    try {
      const { number, message } = req.body
      const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

      await sock.sendMessage(jid, { text: message })
      console.log(`[${EMPRESA_ID}] Mensagem enviada para ${jid}`)
      res.json({ success: true })
    } catch (err) {
      console.error(`[${EMPRESA_ID}] Erro ao enviar mensagem:`, err.message)
      res.status(500).json({ success: false, error: err.message })
    }
  })

  app.listen(PORT, () => {
    console.log(`🌐 [${EMPRESA_ID}] Servidor rodando na porta ${PORT}`)
  })
}

// ===============================
// LISTENER DE MENSAGENS
// ===============================

function registrarListener(sock) {
  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log(`🔔 [${EMPRESA_ID}] messages.upsert disparado! Total: ${messages.length}`)

    for (const msg of messages) {
      try {
        const fromMe = msg.key.fromMe || false
        if (fromMe) continue

        const remoteJid = msg.key.remoteJid
        const messageType = Object.keys(msg.message || {})[0]
        const messageText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          ''

        const payload = {
          from: remoteJid,
          message: messageText,
          type: messageType === 'conversation' ? 'text' : messageType,
          fromMe: false,
        }

        console.log(`📩 [${EMPRESA_ID}] Recebida:`, payload)

        const resp = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Empresa-ID': EMPRESA_ID,
            'X-Webhook-Signature': WEBHOOK_SECRET,
          },
          body: JSON.stringify(payload),
        })

        console.log(`✅ [${EMPRESA_ID}] Webhook respondeu ${resp.status}`)
      } catch (err) {
        console.error(`❌ [${EMPRESA_ID}] Erro no listener:`, err.message)
      }
    }
  })
}

// ===============================
// INÍCIO
// ===============================

iniciarWhatsApp().catch((err) => console.error('Erro na inicialização:', err))
