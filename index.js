
// index.js
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

let qrCodeData = null;

// Inicia conexão com WhatsApp
async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const sock = makeWASocket({ auth: state });

    sock.ev.on('connection.update', (update) => {
        const { qr, connection } = update;
        if (qr) {
            qrCodeData = qr; // guarda QR
            console.log("📲 Novo QR gerado");
        }
        if (connection === 'open') {
            console.log("✅ Conectado ao WhatsApp");
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

startSock();

// Rota para exibir QR Code
app.get('/qr', async (req, res) => {
    if (!qrCodeData) {
        return res.json({ message: "QR ainda não gerado, atualize em alguns segundos." });
    }
    const qrImageUrl = await qrcode.toDataURL(qrCodeData);
    res.send(`<img src="${qrImageUrl}" />`);
});

// Teste de status
app.get('/', (req, res) => {
    res.send("🚀 Servidor WhatsApp rodando!");
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
