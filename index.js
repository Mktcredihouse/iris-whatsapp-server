import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage
} from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'
import P from 'pino'
import express from 'express'
import qrcode from 'qrcode-terminal'
import { Boom } from '@hapi/boom'
import fetch from 'node-fetch'
import dotenv from 'dotenv'

dotenv.config()

// ================================
// 🔧 CONFIGURAÇÕES GERAIS
// ================================
const PORT = process.env.PORT || 10000
const EMPRESA_ID = process.env.EMPRESA_ID || 'Credihouse'
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ssbuwpeasbkxobowfyvw.supabase.co"
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
const BAILEYS_WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || "credlar-shared-secret"

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const app = express()
app.use(express.json({ limit: '50mb' }))

let sock = null
let connectionStatus = {
  connected: false,
  number: null,
  lastUpdate: null
}

// ================================
// 🔐 CONEXÃO COM WHATSAPP
// ================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['IRIS CRM', 'Chrome', '4.0']
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.clear()
      console.log(`📱 [${EMPRESA_ID}] Escaneie o QR Code abaixo para conectar o WhatsApp:`)
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`⚠️ [${EMPRESA_ID}] Conexão encerrada:`, reason)
      connectionStatus.connected = false
      connectionStatus.number = null
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔄 Tentando reconectar...')
        connectToWhatsApp()
      }
    }

    if (connection === 'open') {
      const user = sock?.user?.id?.split(':')[0]
      console.log(`✅ [${EMPRESA_ID}] WhatsApp conectado com sucesso! Número: ${user}`)
      connectionStatus = {
        connected: true,
        number: user,
        lastUpdate: new Date().toISOString()
      }
    }
  })

  // ================================
  // 💬 RECEBIMENTO DE MENSAGENS
  // ================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    console.log('📋 Mensagem detectada:', JSON.stringify(msg.key, null, 2))

    // ✅ IGNORA MENSAGENS ENVIADAS PELA PRÓPRIA IRIS
    if (msg.key.fromMe) {
      console.log('⏩ Ignorando mensagem enviada pela IRIS (fromMe: true)')
      return
    }

    const sender = msg.key.remoteJid
    const pushName = msg.pushName || 'Cliente'
    let content = ''
    let type = 'text'
    let mediaBase64 = null

    // 🖼️ BUSCAR FOTO DE PERFIL
    let profilePicUrl = null
    try {
      profilePicUrl = await sock.profilePictureUrl(sender, 'image')
      console.log(`🖼️ [${EMPRESA_ID}] Foto de perfil capturada para ${sender}`)
    } catch (err) {
      console.log(`⚠️ [${EMPRESA_ID}] Sem foto pública para ${sender}`)
      // Não é erro crítico, alguns contatos não têm foto pública
    }

    try {
      if (msg.message.conversation) {
        content = msg.message.conversation
      } else if (msg.message.extendedTextMessage) {
        content = msg.message.extendedTextMessage.text
      } else if (msg.message.imageMessage) {
        type = 'image'
        content = msg.message.imageMessage.caption || ''
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) })
        mediaBase64 = `data:${msg.message.imageMessage.mimetype};base64,${buffer.toString('base64')}`
      } else if (msg.message.audioMessage) {
        type = 'audio'
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) })
        mediaBase64 = `data:${msg.message.audioMessage.mimetype};base64,${buffer.toString('base64')}`
      } else if (msg.message.videoMessage) {
        type = 'video'
        content = msg.message.videoMessage.caption || ''
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) })
        mediaBase64 = `data:${msg.message.videoMessage.mimetype};base64,${buffer.toString('base64')}`
      } else if (msg.message.documentMessage) {
        type = 'document'
        content = msg.message.documentMessage.fileName || 'Arquivo recebido'
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }) })
        mediaBase64 = `data:${msg.message.documentMessage.mimetype};base64,${buffer.toString('base64')}`
      }

      console.log(`📥 [${EMPRESA_ID}] Mensagem RECEBIDA de cliente - ${type} de ${sender}: ${content}`)

      await supabase.from('chat_mensagens').insert([
        { remetente: sender, mensagem: content, tipo: type, data_envio: new Date(), empresa_id: EMPRESA_ID }
      ])

      // ================================
      // 🔔 ENVIO DO WEBHOOK
      // ================================
      const webhookPayload = {
        from: sender,                          // ✅ Número do cliente (quem enviou)
        to: connectionStatus.number,           // ✅ Número da IRIS (quem recebeu)
        message: content,
        name: pushName,
        profilePicUrl: profilePicUrl,          // ✅ FOTO DE PERFIL
        type,
        media: mediaBase64,
        fromMe: false                          // ✅ Explicitamente FALSE
      }

      console.log('📤 Payload do webhook:', JSON.stringify(webhookPayload, null, 2))

      const response = await fetch("https://ssbuwpeasbkxobowfyvw.supabase.co/functions/v1/baileys-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Empresa-ID": EMPRESA_ID,
          "X-Webhook-Signature": BAILEYS_WEBHOOK_SECRET
        },
        body: JSON.stringify(webhookPayload)
      })

      if (response.ok)
        console.log(`✅ [${EMPRESA_ID}] Webhook Lovable notificado com sucesso.`)
      else
        console.error(`⚠️ [${EMPRESA_ID}] Webhook respondeu com erro: ${response.status}`)

    } catch (err) {
      console.error(`❌ [${EMPRESA_ID}] Erro no recebimento:`, err.message)
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

// ================================
// 📡 ENDPOINT STATUS
// ================================
app.get('/status', (req, res) => {
  res.json({
    success: true,
    empresa_id: EMPRESA_ID,
    connected: connectionStatus.connected,
    number: connectionStatus.number,
    lastUpdate: connectionStatus.lastUpdate
  })
})

// ================================
// ✉️ ENDPOINT ENVIO DE MENSAGEM (COM SUPORTE A URL)
// ================================
app.post('/send-message', async (req, res) => {
  try {
    const { number, message, type, media, fileName } = req.body
    if (!number) return res.status(400).json({ success: false, error: 'Número é obrigatório.' })

    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`
    let sentMsg = null

    console.log(`📤 [${EMPRESA_ID}] Enviando mensagem para ${jid}:`, { type, message: message?.substring(0, 50), hasMedia: !!media })

    if (media) {
      let mediaBuffer;
      
      // ✅ Se for URL, fazer download primeiro
      if (media.startsWith('http://') || media.startsWith('https://')) {
        console.log(`🔽 [${EMPRESA_ID}] Baixando mídia de URL: ${media.substring(0, 80)}...`)
        const response = await fetch(media)
        if (!response.ok) throw new Error(`Erro ao baixar mídia: ${response.status}`)
        mediaBuffer = Buffer.from(await response.arrayBuffer())
        console.log(`✅ [${EMPRESA_ID}] Mídia baixada com sucesso: ${mediaBuffer.length} bytes`)
      } 
      // ✅ Se for base64 com data URI
      else if (media.startsWith('data:')) {
        console.log(`🔄 [${EMPRESA_ID}] Convertendo base64 (data URI)`)
        mediaBuffer = Buffer.from(media.split(',')[1], 'base64')
      } 
      // ✅ Se for base64 puro
      else {
        console.log(`🔄 [${EMPRESA_ID}] Convertendo base64 puro`)
        mediaBuffer = Buffer.from(media, 'base64')
      }

      // ✅ Enviar baseado no tipo
      if (type === 'image') {
        console.log(`📷 [${EMPRESA_ID}] Enviando imagem...`)
        sentMsg = await sock.sendMessage(jid, { image: mediaBuffer, caption: message || '' })
      } else if (type === 'audio') {
        console.log(`🎵 [${EMPRESA_ID}] Enviando áudio...`)
        sentMsg = await sock.sendMessage(jid, { audio: mediaBuffer, mimetype: 'audio/mp4', ptt: true })
      } else if (type === 'video') {
        console.log(`🎬 [${EMPRESA_ID}] Enviando vídeo...`)
        sentMsg = await sock.sendMessage(jid, { video: mediaBuffer, caption: message || '' })
      } else if (type === 'document') {
        const docFileName = fileName || message || 'arquivo.pdf'
        console.log(`📄 [${EMPRESA_ID}] Enviando documento: ${docFileName}`)
        sentMsg = await sock.sendMessage(jid, {
          document: mediaBuffer,
          mimetype: 'application/pdf',
          fileName: docFileName
        })
      } else {
        // Se não especificou tipo mas tem mídia, tentar detectar pela extensão
        const ext = media.split('.').pop()?.split('?')[0]?.toLowerCase()
        console.log(`🔍 [${EMPRESA_ID}] Tipo não especificado, detectando pela extensão: ${ext}`)
        
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
          sentMsg = await sock.sendMessage(jid, { image: mediaBuffer, caption: message || '' })
        } else if (['pdf', 'doc', 'docx', 'xlsx'].includes(ext)) {
          sentMsg = await sock.sendMessage(jid, {
            document: mediaBuffer,
            mimetype: 'application/pdf',
            fileName: fileName || message || 'arquivo.pdf'
          })
        } else {
          throw new Error(`Tipo de mídia não suportado: ${ext}`)
        }
      }
    } else {
      console.log(`💬 [${EMPRESA_ID}] Enviando mensagem de texto`)
      sentMsg = await sock.sendMessage(jid, { text: message })
    }

    console.log(`✅ [${EMPRESA_ID}] Mensagem enviada com sucesso!`)

    await supabase.from('chat_mensagens').insert([
      {
        remetente: connectionStatus.number,
        destinatario: number,
        mensagem: message || '(mídia)',
        tipo: type || 'text',
        data_envio: new Date(),
        empresa_id: EMPRESA_ID
      }
    ])

    res.json({ success: true, message: 'Mensagem enviada com sucesso.' })
  } catch (error) {
    console.error(`❌ [${EMPRESA_ID}] Erro ao enviar mensagem:`, error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ================================
// 🚪 ENDPOINT LOGOUT
// ================================
app.get('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout()
      connectionStatus.connected = false
      console.log(`🚪 [${EMPRESA_ID}] Sessão encerrada manualmente.`)
      return res.json({ success: true, message: 'Sessão encerrada.' })
    }
    res.status(400).json({ success: false, message: 'Nenhuma sessão ativa.' })
  } catch (err) {
    console.error(`❌ [${EMPRESA_ID}] Erro ao desconectar:`, err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ================================
// 🚀 INICIALIZA SERVIDOR
// ================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 [${EMPRESA_ID}] Servidor Baileys rodando na porta ${PORT}`)
  connectToWhatsApp()
})
