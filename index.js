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

// ================================
// 🔧 CONFIGURAÇÕES GERAIS
// ================================
const PORT = process.env.PORT || 10000
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ssbuwpeasbkxobowfyvw.supabase.co"
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzYnV3cGVhc2JreG9ib3dmeXZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4NzA4MjEsImV4cCI6MjA3NTQ0NjgyMX0.plDzeNZQZEv8-3OX09VSTAUURq01zLm0PXxc2KdPAuY"

// Inicializa Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Inicializa Express
const app = express()
app.use(express.json())

let sock = null
let connectionStatus = {
  connected: false,
  number: null,
  lastUpdate: null
}

// ================================
// 🔐 INICIALIZAÇÃO DO BAILEYS
// ================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()
  
  sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['Iris CRM', 'Chrome', '4.0']
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.clear()
      console.log('📱 Escaneie o QR Code abaixo para conectar o WhatsApp:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log('⚠️ Conexão fechada:', reason)
      connectionStatus.connected = false
      connectionStatus.number = null

      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔄 Tentando reconectar...')
        connectToWhatsApp()
      }
    }

    if (connection === 'open') {
      const user = sock?.user?.id?.split(':')[0]
      console.log(`✅ WhatsApp conectado com sucesso! Número: ${user}`)
      connectionStatus = {
        connected: true,
        number: user,
        lastUpdate: new Date().toISOString()
      }

      await supabase
        .from('whatsapp_connection')
        .insert([{ status: 'connected', numero: user, updated_at: new Date() }])
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    const sender = msg.key.remoteJid
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text

    console.log(`📩 Mensagem recebida de ${sender}: ${text}`)

    await supabase
      .from('chat_mensagens')
      .insert([
        {
          remetente: sender,
          mensagem: text,
          data_envio: new Date()
        }
      ])
  })

  sock.ev.on('creds.update', saveCreds)
}

// ================================
// 📡 ENDPOINT: STATUS
// ================================
app.get('/status', async (req, res) => {
  const { connected, number, lastUpdate } = connectionStatus
  res.json({
    success: true,
    connected,
    number,
    lastUpdate,
    timestamp: new Date().toISOString()
  })
})

// ================================
// ✉️ ENDPOINT: SEND-MESSAGE
// ================================
app.post('/send-message', async (req, res) => {
  try {
    const { number, message } = req.body

    console.log('📤 Requisição recebida do Lovable:')
    console.log('Número:', number)
    console.log('Mensagem:', message)

    // Validação básica
    if (!number || !message) {
      console.error('❌ Requisição inválida: falta número ou mensagem.')
      return res.status(400).json({ success: false, error: 'Número e mensagem são obrigatórios.' })
    }

    if (!sock || !connectionStatus.connected) {
      console.error('❌ Baileys não conectado.')
      return res.status(503).json({ success: false, error: 'Servidor WhatsApp não conectado.' })
    }

    // Corrige o formato do número
    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

    // Envia a mensagem
    const sentMsg = await sock.sendMessage(jid, { text: message })

    console.log('✅ Mensagem enviada com sucesso:', sentMsg.key.id)

    await supabase
      .from('chat_mensagens')
      .insert([
        {
          remetente: connectionStatus.number,
          destinatario: number,
          mensagem: message,
          data_envio: new Date()
        }
      ])

    return res.json({
      success: true,
      message: 'Mensagem enviada com sucesso.',
      waId: sentMsg.key.id
    })
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno ao enviar mensagem.'
    })
  }
})

// ================================
// 🚀 INICIA SERVIDOR
// ================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`)
  connectToWhatsApp()
})
