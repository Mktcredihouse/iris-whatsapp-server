import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import express from 'express'
import qrcode from 'qrcode-terminal'
import P from 'pino'

const app = express()
app.use(express.json())

const logger = P({ level: 'info' })

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger
  })

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      console.log('📱 Escaneie este QR Code para conectar:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('❌ Conexão fechada. Reconectar?', shouldReconnect)
      if (shouldReconnect) {
        startWhatsApp()
      }
    } else if (connection === 'open') {
      console.log('✅ Conectado com sucesso ao WhatsApp!')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // 🌐 Endpoint para enviar mensagens
  app.post('/send-message', async (req, res) => {
    const { number, message } = req.body
    if (!number || !message) {
      return res.status(400).json({ error: 'Informe number e message no corpo da requisição' })
    }

    try {
      const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`
      await sock.sendMessage(jid, { text: message })
      res.json({ success: true })
    } catch (error) {
      console.error('Erro ao enviar mensagem:', error)
      res.status(500).json({ error: 'Falha ao enviar mensagem' })
    }
  })
}

startWhatsApp()

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP rodando na porta ${PORT}`)
})
