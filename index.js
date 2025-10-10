import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: pino({ level: 'silent' }),
  })

  // Evento de QR Code
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('📲 Escaneie este QR Code para conectar:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('❌ Conexão fechada', lastDisconnect?.error)
      if (shouldReconnect) {
        startSocket()
      }
    } else if (connection === 'open') {
      console.log('✅ Conectado com sucesso ao WhatsApp!')
    }
  })

  // Evento para salvar sessão automaticamente
  sock.ev.on('creds.update', saveCreds)
}

startSocket()
