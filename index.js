import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys'
import express from 'express'
import qrcode from 'qrcode'

const app = express()
const port = process.env.PORT || 10000

let currentQR = null // guarda o último QR gerado

// Endpoint para visualizar o QR no navegador
app.get('/qr', async (req, res) => {
  if (!currentQR) {
    return res.send('⚠️ Nenhum QR Code gerado ainda. Aguarde alguns segundos e atualize a página.')
  }

  try {
    const qrImage = await qrcode.toDataURL(currentQR)
    res.send(`
      <html>
        <head><title>WhatsApp QR</title></head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#111;">
          <div>
            <h2 style="color:white;text-align:center;">📲 Escaneie o QR Code abaixo</h2>
            <img src="${qrImage}" />
          </div>
        </body>
      </html>
    `)
  } catch (err) {
    console.error(err)
    res.status(500).send('Erro ao gerar QR')
  }
})

// Inicializa servidor HTTP
app.listen(port, () => console.log(`🌐 Servidor HTTP rodando na porta ${port}`))

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '22.04'],
  })

  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update

    if (qr) {
      currentQR = qr // salva o QR atual
      console.log('📡 Novo QR gerado! Acesse /qr para escanear.')
    }

    if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp com sucesso!')
      currentQR = null // limpa QR depois da conexão
    } else if (connection === 'close') {
      console.log('❌ Conexão fechada. Tentando reconectar...')
      startWhatsApp()
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

startWhatsApp()
