import express from 'express'
import cors from 'cors'
import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys'

const app = express()
app.use(cors())
app.use(express.json())

let sockGlobal = null

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '22.04'],
  })

  sockGlobal = sock

  sock.ev.on('connection.update', (update) => {
    const { connection } = update
    if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp com sucesso!')
    } else if (connection === 'close') {
      console.log('❌ Conexão fechada. Tentando reconectar...')
      startWhatsApp()
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ✅ Recebendo mensagens
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.key.fromMe && msg.message?.conversation) {
      const texto = msg.message.conversation
      const remetente = msg.key.remoteJid
      console.log(`📩 Nova mensagem de ${remetente}: ${texto}`)

      // 👉 Aqui você pode enviar via webhook para Lovable
      await fetch('https://seu-site-lovable.com/api/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: remetente, message: texto }),
      })
    }
  })
}

startWhatsApp()

// ✅ Endpoint para enviar mensagens (Lovable → WhatsApp)
app.post('/send', async (req, res) => {
  const { number, message } = req.body
  if (!sockGlobal) return res.status(500).send('Sessão não inicializada')

  try {
    const jid = number.replace(/\D/g, '') + '@s.whatsapp.net'
    await sockGlobal.sendMessage(jid, { text: message })
    res.send({ success: true })
  } catch (error) {
    console.error(error)
    res.status(500).send({ success: false })
  }
})

app.listen(10000, () => {
  console.log('🌐 Servidor HTTP rodando na porta 10000')
})
