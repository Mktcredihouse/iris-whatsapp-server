{
  "name": "iris-crm",
  "version": "1.0.0",
  "description": "CRM e Chat WhatsApp integrados ao Lovable Cloud (Supabase) utilizando Baileys.",
  "main": "index.js",
  "type": "module",
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js"
  },
  "author": "Credlar Construtora",
  "license": "MIT",
  "dependencies": {
    "@supabase/supabase-js": "^2.46.1",
    "@whiskeysockets/baileys": "^6.6.0",
    "@hapi/boom": "^10.0.1",
    "express": "^4.19.2",
    "pino": "^8.15.0",
    "qrcode-terminal": "^0.12.0",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "nodemon": "^3.1.4"
  }
}
