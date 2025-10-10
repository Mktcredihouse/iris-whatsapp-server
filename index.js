import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import express from 'express'

const app = express()
const port = process.env.PORT || 10000

// Inicia servidor HTTP simples só pra manter a instância viva no Render
app.get('/', (req, res) => res.send('Servidor WhatsApp rodando 🚀'))
app.listen(port, () => console.log(`🌐 Servidor HTTP rodando na porta ${port}`))

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Desativado, vamos mostrar manualmente
    browser: ['Ubuntu', 'Chrome', '22.04'],
  })

  // Escuta eventos da conexão
  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update

    if (qr) {
      console.log('📲 Escaneie este QR Code para conectar:')
      qrcode.generate(qr, { small: true }) // 👉 Exibe o QR no terminal
    }

    if (connection === 'open') {
      console.log('✅ Conectado com sucesso ao WhatsApp!')
    } else if (connection === 'close') {
      console.log('❌ Conexão fechada. Tentando reconectar...')
      startWhatsApp()
    }
  })

  // Salva as credenciais sempre que forem atualizadas
  sock.ev.on('creds.update', saveCreds)
}

startWhatsApp()
