console.log("Iniciando script del servidor con Baileys...");

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const qrcode = require('qrcode');

// --- Configuración del Servidor ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});
const PORT = process.env.PORT || 3001;

let sock;
let qrCodeUrl = '';

async function connectToWhatsApp() {
    console.log('Iniciando conexión con WhatsApp...');
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Usando Baileys v${version.join('.')}, es la última versión: ${isLatest}`);

    sock = makeWASocket({
        version,
        printQRInTerminal: true,
        auth: state,
        browser: ['Hoprin+', 'Chrome', '1.0.0'],
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('QR recibido, enviando al frontend...');
            qrCodeUrl = await qrcode.toDataURL(qr);
            io.emit('qr', qrCodeUrl);
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada, motivo:', lastDisconnect.error, ', reconectando:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('¡Conexión con WhatsApp abierta!');
            io.emit('status', 'Conectado exitosamente a WhatsApp.');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const sender = msg.key.remoteJid;
        const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        console.log(`Nuevo mensaje de ${sender}: ${messageText}`);

        // TODO: Lógica de negocio
        const messageData = {
            from: sender,
            body: messageText,
            contact: { name: msg.pushName || sender }
        };
        io.emit('nuevo_mensaje', messageData);
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// --- Eventos de Socket.IO ---
io.on('connection', (socket) => {
    console.log(`Un usuario frontend se ha conectado: ${socket.id}`);
    if (qrCodeUrl) {
        socket.emit('qr', qrCodeUrl);
    }
    socket.on('enviar_mensaje', async ({ to, message }) => {
        try {
            if (sock && sock.user) {
                console.log(`Enviando mensaje a ${to}: ${message}`);
                await sock.sendMessage(to, { text: message });
            } else {
                throw new Error('WhatsApp no está conectado.');
            }
        } catch (err) {
            console.error('Error al enviar mensaje:', err);
            socket.emit('envio_error', { to, error: 'No se pudo enviar el mensaje.' });
        }
    });
    socket.on('disconnect', () => {
        console.log(`Usuario frontend desconectado: ${socket.id}`);
    });
});

// --- Iniciar el Servidor y la Conexión ---
server.listen(PORT, () => {
    console.log(`Servidor Hoprin+ iniciado y escuchando en el puerto ${PORT}`);
    connectToWhatsApp().catch(err => console.log("Error inesperado al iniciar:", err));
});
