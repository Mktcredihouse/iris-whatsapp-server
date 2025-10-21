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
const EMPRESA_ID = process.env.EMPRESA_ID || 'empresa_default'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const WEBHOOK_URL = process.env.WEBHOOK_URL
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const app = express()
app.use(express.json())

let sock = null
let qrCodeData = null
let connectionStatus = 'disconnected'
let connectedNumber = null
let lastUpdate = new Date()

// ================================
// 🔐 CONEXÃO COM WHATSAPP
// ================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' }),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log(`📱 [${EMPRESA_ID}] QR Code gerado!`)
      qrCodeData = qr
      qrcode.generate(qr, { small: true })
      
      await supabase.from('whatsapp_connection').upsert({
        company_id: EMPRESA_ID,
        qr_code: qr,
        is_connected: false,
      }, { onConflict: 'company_id' })
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut
      console.log(`❌ [${EMPRESA_ID}] Conexão fechada. Reconectar?`, shouldReconnect)
      
      connectionStatus = 'disconnected'
      connectedNumber = null
      lastUpdate = new Date()
      
      await supabase.from('whatsapp_connection').update({
        is_connected: false,
        connected_number: null,
      }).eq('company_id', EMPRESA_ID)

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000)
      }
    } else if (connection === 'open') {
      console.log(`✅ [${EMPRESA_ID}] Conectado ao WhatsApp!`)
      connectionStatus = 'connected'
      connectedNumber = sock.user?.id.split(':')[0] || null
      lastUpdate = new Date()
      
      await supabase.from('whatsapp_connection').update({
        is_connected: true,
        connected_number: connectedNumber,
        last_connected_at: new Date().toISOString(),
      }).eq('company_id', EMPRESA_ID)
    }
  })

  // ================================
  // 🔵 LISTENER PARA STATUS DE MENSAGEM (CHECKS AZUIS)
  // ================================
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      const { key, update: status } = update
      
      if (status.status) {
        const messageId = key.id
        const readStatus = status.status.toLowerCase() // 'read', 'delivered', 'sent'
        
        console.log(`📱 [${EMPRESA_ID}] Status atualizado: ${messageId} -> ${readStatus}`)
        
        // Enviar para edge function
        try {
          await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-message-status`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SUPABASE_KEY}`
            },
            body: JSON.stringify({
              messageId: messageId,
              status: readStatus,
              timestamp: Date.now()
            })
          })
          console.log(`✅ [${EMPRESA_ID}] Status enviado para Supabase`)
        } catch (err) {
          console.error(`❌ [${EMPRESA_ID}] Erro ao atualizar status:`, err)
        }
      }
    }
  })

  // ================================
  // 💬 RECEBIMENTO DE MENSAGENS
  // ================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const sender = msg.key.remoteJid
      const senderName = msg.pushName || sender.split('@')[0]
      
      // 🖼️ BUSCAR FOTO DE PERFIL
      let profilePicUrl = null
      try {
        profilePicUrl = await sock.profilePictureUrl(sender, 'image')
        console.log(`🖼️ [${EMPRESA_ID}] Foto de perfil capturada para ${sender}`)
      } catch (err) {
        console.log(`⚠️ [${EMPRESA_ID}] Sem foto de perfil pública para ${sender}`)
      }

      let messageText = null
      let messageType = 'text'
      let mediaUrl = null

      if (msg.message.conversation) {
        messageText = msg.message.conversation
      } else if (msg.message.extendedTextMessage) {
        messageText = msg.message.extendedTextMessage.text
      } else if (msg.message.imageMessage) {
        messageType = 'image'
        messageText = msg.message.imageMessage.caption || 'Imagem recebida'
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const { data, error } = await supabase.storage
            .from('chat-files')
            .upload(`${EMPRESA_ID}/${msg.key.id}.jpg`, buffer, {
              contentType: 'image/jpeg',
            })
          if (!error) {
            const { data: publicUrl } = supabase.storage
              .from('chat-files')
              .getPublicUrl(data.path)
            mediaUrl = publicUrl.publicUrl
          }
        } catch (err) {
          console.error(`❌ [${EMPRESA_ID}] Erro ao baixar imagem:`, err)
        }
      } else if (msg.message.audioMessage) {
        messageType = 'audio'
        messageText = 'Áudio recebido'
      } else if (msg.message.videoMessage) {
        messageType = 'video'
        messageText = msg.message.videoMessage.caption || 'Vídeo recebido'
      } else if (msg.message.documentMessage) {
        messageType = 'document'
        const fileName = msg.message.documentMessage.fileName || 'documento'
        messageText = `Documento: ${fileName}`
      }

      console.log(`📨 [${EMPRESA_ID}] ${senderName}: ${messageText}`)

      // Enviar webhook
      if (WEBHOOK_URL) {
        try {
          const webhookPayload = {
            from: sender,
            to: sock.user?.id.split('@')[0] || 'unknown',
            message: messageText,
            name: senderName,
            profilePicUrl: profilePicUrl, // 🖼️ INCLUIR FOTO
            type: messageType,
            media: mediaUrl,
            fromMe: false,
            companyId: EMPRESA_ID
          }

          await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Company-ID': EMPRESA_ID,
              'X-Webhook-Secret': WEBHOOK_SECRET,
            },
            body: JSON.stringify(webhookPayload),
          })

          console.log(`✅ [${EMPRESA_ID}] Webhook enviado`)
        } catch (err) {
          console.error(`❌ [${EMPRESA_ID}] Erro ao enviar webhook:`, err)
        }
      }
    }
  })
}

// ================================
// 📡 ENDPOINT STATUS
// ================================
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    number: connectedNumber,
    lastUpdate: lastUpdate,
  })
})

// ================================
// ✉️ ENDPOINT ENVIO DE MENSAGEM
// ================================
app.post('/send-message', async (req, res) => {
  try {
    const { number, message, media, fileName } = req.body

    if (!number || (!message && !media)) {
      return res.status(400).json({ error: 'Número e mensagem/mídia são obrigatórios' })
    }

    let formattedNumber = number
    if (!formattedNumber.includes('@')) {
      formattedNumber = `${formattedNumber}@s.whatsapp.net`
    }

    let sentMsg

    if (media) {
      const mediaBuffer = Buffer.from(media.split(',')[1] || media, 'base64')
      
      if (fileName) {
        sentMsg = await sock.sendMessage(formattedNumber, {
          document: mediaBuffer,
          fileName: fileName,
          caption: message || '',
        })
      } else {
        sentMsg = await sock.sendMessage(formattedNumber, {
          image: mediaBuffer,
          caption: message || '',
        })
      }
    } else {
      sentMsg = await sock.sendMessage(formattedNumber, {
        text: message,
      })
    }

    console.log(`✅ [${EMPRESA_ID}] Mensagem enviada para ${number}`)
    
    res.status(200).json({ 
      success: true, 
      message: "Mensagem enviada com sucesso.",
      messageId: sentMsg.key.id,  // 🔵 RETORNAR MESSAGE ID
      key: sentMsg.key              // 🔵 RETORNAR KEY COMPLETA
    })
  } catch (error) {
    console.error(`❌ [${EMPRESA_ID}] Erro ao enviar mensagem:`, error)
    res.status(500).json({ error: error.message })
  }
})

// ================================
// 🚪 ENDPOINT LOGOUT
// ================================
app.get('/logout', async (req, res) => {
  try {
    await sock.logout()
    connectionStatus = 'disconnected'
    connectedNumber = null
    
    await supabase.from('whatsapp_connection').update({
      is_connected: false,
      connected_number: null,
    }).eq('company_id', EMPRESA_ID)

    res.json({ success: true, message: 'Desconectado com sucesso' })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// ================================
// 🚀 INICIALIZA SERVIDOR
// ================================
app.listen(PORT, () => {
  console.log(`🚀 [${EMPRESA_ID}] Servidor rodando na porta ${PORT}`)
  connectToWhatsApp()
})
