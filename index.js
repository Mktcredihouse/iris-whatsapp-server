import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { createClient } from '@supabase/supabase-js'
import express from 'express'
import qrcode from 'qrcode-terminal'
import P from 'pino'
import fetch from 'node-fetch'

// ================================
// 🔧 CONFIGURAÇÕES GERAIS
// ================================
const PORT = process.env.PORT || 3000
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ssbuwpeasbkxobowfyvw.supabase.co"
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzYnV3cGVhc2JreG9ib3dmeXZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4NzA4MjEsImV4cCI6MjA3NTQ0NjgyMX0.plDzeNZQZEv8-3OX09VSTAUURq01zLm0PXxc2KdPAuY"
const WEBHOOK_URL = process.env.WEBHOOK_URL || null

// Inicializa Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Inicializa Express
const app = express()
app.use(express.json())

// Variável global para status da conexão
let whatsappStatus = {
  connected: false,
  lastConnection: null,
  lastMessage: null
}

// ================================
// 🔐 INICIALIZAÇÃO DO BAILEYS
// ================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['Iris CRM', 'Chrome', '4.0']
  })

  // ================================
  // 📲 STATUS DA CONEXÃO
  // ================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.clear()
      console.log('📱 Escaneie o QR Code abaixo para conectar o WhatsApp:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      whatsappStatus.connected = false
      if (reason === DisconnectReason.loggedOut) {
        console.log('❌ Sessão encerrada. Apague a pasta "session" e reconecte.')
      } else {
        console.log('🔄 Reconectando...')
        connectToWhatsApp()
      }
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp conectado com sucesso!')
      whatsappStatus.connected = true
      whatsappStatus.lastConnection = new Date()

      await supabase
        .from('whatsapp_connection')
        .insert([{ status: 'connected', updated_at: new Date() }])
    }
  })

  // ================================
  // 💬 RECEBIMENTO DE MENSAGENS
  // ================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    const sender = msg.key.remoteJid
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
    const timestamp = new Date()

    console.log(`📩 Mensagem recebida de ${sender}: ${text}`)
    whatsappStatus.lastMessage = { sender, text, timestamp }

    try {
      // Salva no Supabase
      await supabase
        .from('chat_mensagens')
        .insert([
          {
            remetente: sender,
            mensagem: text,
            data_envio: timestamp
          }
        ])

      // Envia também para o webhook IRIS (caso configurado)
      if (WEBHOOK_URL) {
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: sender,
            message: text,
            data_envio: timestamp
          })
        })
      }
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error)
    }
  })

  // ================================
  // ✉️ ENVIO DE MENSAGENS VIA API LOCAL
  // ================================
  app.post('/send-message', async (req, res) => {
    const { number, message } = req.body
    try {
      await sock.sendMessage(`${number}@s.whatsapp.net`, { text: message })

      await supabase
        .from('chat_mensagens')
        .insert([
          {
            remetente: 'system',
            destinatario: number,
            mensagem: message,
            data_envio: new Date()
          }
        ])

      return res.json({ success: true, message: 'Mensagem enviada!' })
    } catch (error) {
      console.error('❌ Erro ao enviar mensagem:', error)
      return res.status(500).json({ success: false, error: error.message })
    }
  })

  // ================================
  // 📡 ROTA DE STATUS DO SERVIDOR
  // ================================
  app.get('/status', async (req, res) => {
    try {
      const { data: dbStatus } = await supabase.from('whatsapp_connection').select('*').limit(1).order('updated_at', { ascending: false })
      res.json({
        whatsapp: whatsappStatus.connected ? '🟢 Conectado' : '🔴 Desconectado',
        ultima_conexao: whatsappStatus.lastConnection,
        ultima_mensagem: whatsappStatus.lastMessage,
        banco: dbStatus && dbStatus.length > 0 ? dbStatus[0].status : 'indefinido',
        timestamp: new Date()
      })
    } catch (error) {
      res.status(500).json({ error: 'Erro ao consultar status', details: error.message })
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

// ================================
// 🚀 INICIALIZA SERVIDOR E BAILEYS
// ================================
app.listen(PORT, () => {
  console.log(`🌐 Servidor Baileys rodando na porta ${PORT}`)
  connectToWhatsApp()
})
