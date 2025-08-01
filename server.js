// --- Hoprin+ Backend Server (Versión Robusta para Despliegue) ---
console.log("Iniciando script del servidor...");

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// --- Configuración del Servidor ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Render asigna el puerto dinámicamente. Esta es la forma correcta de usarlo.
const PORT = process.env.PORT || 3001;

// --- Inicialización del Cliente de WhatsApp ---
console.log('Inicializando cliente de WhatsApp...');
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth' // Especificamos una ruta para la sesión
    }),
    puppeteer: {
        headless: true,
        // **LA CORRECCIÓN MÁS IMPORTANTE ESTÁ AQUÍ**
        // Estos argumentos son cruciales para que Chrome/Puppeteer funcione en entornos de servidor como Render.
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // <- este puede no ser necesario, pero ayuda en entornos con poca memoria
            '--disable-gpu'
        ],
    }
});

// --- Eventos del Cliente de WhatsApp ---
client.on('qr', async (qr) => {
    console.log('Evento QR recibido. Generando Data URL...');
    const qrDataURL = await qrcode.toDataURL(qr);
    console.log('QR generado. Enviando al frontend.');
    io.emit('qr', qrDataURL);
});

client.on('ready', () => {
    console.log('¡Cliente de WhatsApp está listo y conectado!');
    io.emit('status', 'Conectado exitosamente a WhatsApp.');
});

client.on('message', async (message) => {
    console.log(`Nuevo mensaje de: ${message.from}`);
    const contact = await message.getContact();
    const messageData = {
        from: message.from,
        body: message.body,
        contact: { name: contact.name || contact.pushname }
    };
    io.emit('nuevo_mensaje', messageData);
});

client.on('disconnected', (reason) => {
    console.log('Cliente de WhatsApp fue desconectado.', reason);
    io.emit('status', 'Desconectado de WhatsApp.');
    client.initialize();
});

console.log('A punto de llamar a client.initialize()...');
client.initialize().catch(err => console.error('Fallo al inicializar el cliente:', err));


// --- Eventos de Socket.IO ---
io.on('connection', (socket) => {
    console.log(`Un usuario frontend se ha conectado: ${socket.id}`);
    socket.on('disconnect', () => {
        console.log(`Usuario frontend desconectado: ${socket.id}`);
    });
});

// --- Iniciar el Servidor ---
server.listen(PORT, () => {
    console.log(`Servidor Hoprin+ iniciado y escuchando en el puerto ${PORT}`);
});
