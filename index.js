import express from 'express';
import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

// Define a pasta de autenticação
const authFolder = './auth_info';

// Garante que a pasta existe (se não existir, cria)
if (!fs.existsSync(authFolder)) {
  fs.mkdirSync(authFolder, { recursive: true });
}

async function startWhatsApp() {
  // Inicializa o estado de autenticação
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  // Cria conexão com WhatsApp
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // Mostra o QR no terminal
  });

  sock.ev.on('creds.update', saveCreds);

  console.log('✅ Servidor WhatsApp iniciado');
}

// Inicia servidor HTTP (Render precisa disso para manter o container ativo)
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Servidor WhatsApp rodando ✅'));
app.listen(PORT, () => console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`));

// Inicia o bot
startWhatsApp();
