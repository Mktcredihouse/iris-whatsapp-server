// index.js
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import express from 'express'
import cors from 'cors'
import bodyParser from 'body-parser'
import fetch from 'node-fetch'

const app = express()
app.use(cors())
app.use(bodyParser.json())

// Variáveis de ambiente (Render)
const PORT = process.env.PORT || 10000
const WEBHOOK_URL = process.env.WEBHOOK_URL
const API_TOKEN = process.env.API_TOKEN || 'seu-token-secreto'
const SESSION_ID = process.env.SESSION_ID || 'iris-session'

let sock

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(`./${SESSION_ID}`)

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Não imprime automático — nós tratamos manualmente abaixo
  })

  // 🟣 QR Code — exibe no terminal Render
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('📲 Escaneie este QR Code abaixo para conectar:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      console.log('❌ Conexão encerrada. Tentando reconectar...', reason)
      startSock()
    } else if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp com sucesso!')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // 📩 Receber mensagens e enviar para o Lovable (Webhook)
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.message || msg.key.fromMe) return

    const remoteJid = msg.key.remoteJid
    const textMsg = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

    console.log('📨 Mensagem recebida de', remoteJid, ':', textMsg)

    if (WEBHOOK_URL) {
      try {
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            remoteJid,
            message: textMsg,
            timestamp: Date.now(),
          }),
        })
      } catch (err) {
        console.error('Erro ao enviar mensagem para Webhook:', err)
      }
    }
  })
}

// ✉️ Endpoint de envio (usado pelo Lovable)
app.post('/send', async (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader || authHeader !== `Bearer ${API_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { to, message } = req.body
  if (!to || !message) {
    return res.status(400).json({ error: 'Campos "to" e "message" são obrigatórios.' })
  }

  try {
    await sock.sendMessage(`${to}@s.whatsapp.net`, { text: message })
    console.log(`📤 Mensagem enviada para ${to}: ${message}`)
    res.json({ success: true })
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error)
    res.status(500).json({ error: 'Falha ao enviar mensagem' })
  }
})

// 🚀 Iniciar servidor Express + WhatsApp
app.listen(PORT, async () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`)
  await startSock()
})
