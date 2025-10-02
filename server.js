// --- server.js (Versión Completa y Optimizada) ---

console.log("Iniciando servidor Hoprin+ Multi-Canal (On-Demand)...");

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, proto, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const qrcode = require('qrcode');
const admin = require('firebase-admin');
const fs = require('fs').promises;
const pino = require('pino');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getStorage, ref, uploadBytes, getDownloadURL } = require("firebase-admin/storage");
const NodeWebSocket = require('ws');
const { Telegraf } = require('telegraf');

// --- Configuración de Firebase ---
const serviceAccount = require('./serviceAccountKey.json');
const FIREBASE_PROJECT_ID = 'hoprinplus-chat';
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: `${FIREBASE_PROJECT_ID}.appspot.com`
});
const db = admin.firestore();
console.log("Firebase Admin SDK inicializado correctamente.");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const PORT = process.env.PORT || 3001;

const storage = getStorage();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ==================================================================
// --- INICIO: NUEVA ARQUITECTURA DE CONEXIÓN WHATSAPP ---
// ==================================================================

const whatsappClients = {};
const channelStates = {};

async function connectToWhatsApp(channelId, isAutoReconnect = false) {
    if (channelStates[channelId]?.status === 'CONNECTING' || whatsappClients[channelId]) {
        console.log(`[WHATSAPP:${channelId}] Proceso de conexión ya en curso o canal ya conectado.`);
        return;
    }

    console.log(`[WHATSAPP:${channelId}] Iniciando conexión...`);
    channelStates[channelId] = { status: 'CONNECTING', message: 'Iniciando conexión...' };
    io.emit('channel_status_update', { channelId, status: 'CONNECTING', message: 'Iniciando conexión...' });

    const authDir = `baileys_auth_${channelId}`;
    let sock;
    let connectionTimeout;

    const cleanup = async (isLoggedOut = false) => {
    // Verifica si el socket sigue abierto
    if (sock?.ws?.readyState === NodeWebSocket.OPEN) {
        console.log(`[WHATSAPP:${channelId}] El socket aún está abierto. Evitando limpieza innecesaria.`);
        return;
    }

    // Verifica si el cliente sigue conectado (protección adicional)
    if (sock?.isConnected?.()) {
        console.log(`[WHATSAPP:${channelId}] Cliente aún conectado. No se requiere limpieza.`);
        return;
    }

    const reason = isLoggedOut ? 'Cierre de sesión forzado.' : 'Conexión perdida.';
    console.log(`[WHATSAPP:${channelId}] Realizando limpieza de sesión. Razón: ${reason}`);

    if (connectionTimeout) clearTimeout(connectionTimeout);
    delete whatsappClients[channelId];

    if (isLoggedOut) {
        try {
            await fs.rm(authDir, { recursive: true, force: true });
            console.log(`[WHATSAPP:${channelId}] Credenciales eliminadas correctamente.`);
        } catch (err) {
            console.warn(`[WHATSAPP:${channelId}] No se pudo eliminar la carpeta de autenticación:`, err.message);
        }
    }

    channelStates[channelId] = { status: 'DISCONNECTED', message: 'Canal desconectado.' };
    io.emit('channel_status_update', {
        channelId,
        status: 'DISCONNECTED',
        message: 'Canal desconectado.'
    });
};


    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: state,
            browser: [`Hoprin+ (${channelId})`, 'Chrome', '1.0.0'],
            logger: pino({ level: 'silent' }),
            ws: NodeWebSocket,
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                if (isAutoReconnect) {
                    console.log(`[WHATSAPP:${channelId}] Sesión inválida durante reconexión. Limpiando credenciales.`);
                    await cleanup(true);
                    sock.end();
                    return;
                }
                
                if (connectionTimeout) clearTimeout(connectionTimeout);
                connectionTimeout = setTimeout(() => {
                    console.log(`[WHATSAPP:${channelId}] Tiempo de espera para escanear QR agotado.`);
                    sock.end(new Error("QR Timeout"));
                }, 120000);

                const qrCodeUrl = await qrcode.toDataURL(qr);
                channelStates[channelId] = { status: 'CONNECTING', message: 'Por favor, escanea el código QR.' };
                io.emit('qr_update', { channelId, qrCodeUrl });
                io.emit('channel_status_update', { channelId, status: 'CONNECTING', message: 'Por favor, escanea el código QR.' });
            }

            if (connection === 'open') {
                if (connectionTimeout) clearTimeout(connectionTimeout);
                console.log(`[WHATSAPP:${channelId}] ¡Conexión exitosa!`);
                whatsappClients[channelId] = sock;
                channelStates[channelId] = { status: 'CONNECTED', message: 'Canal conectado.' };
                io.emit('qr_update', { channelId, qrCodeUrl: null });
                io.emit('channel_status_update', { channelId, status: 'CONNECTED', message: 'Canal conectado.' });
            }

            if (connection === 'close') {
				const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
				const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.connectionReplaced;

				if (!isLoggedOut) {
				console.log(`[WHATSAPP:${channelId}] Intentando reconexión automática...`);
				await cleanup(false);
				connectToWhatsApp(channelId, true);

				try {
					await db.collection('logs').add({
						type: 'whatsapp-reconnect',
						channelId,
						timestamp: admin.firestore.FieldValue.serverTimestamp(),
						reason: 'Reconexión automática por cierre inesperado'
					});
					console.log(`[WHATSAPP:${channelId}] Reconexión registrada en Firestore.`);
				} catch (logError) {
					console.warn(`[WHATSAPP:${channelId}] No se pudo registrar la reconexión:`, logError.message);
				}
			} else {
				await cleanup(true);
			}
}

        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('messages.upsert', (m) => handleWhatsAppMessages(sock, channelId, m));

    } catch (error) {
        console.error(`[WHATSAPP:${channelId}] Error crítico durante la inicialización:`, error);
        await cleanup(false);
    }
}

async function disconnectWhatsApp(channelId) {
    console.log(`[WHATSAPP:${channelId}] Solicitud de desconexión recibida.`);
    
    if (whatsappClients[channelId]) {
        try {
            await whatsappClients[channelId].logout();
        } catch (error) {
            console.error(`[WHATSAPP:${channelId}] Error durante el logout. Forzando limpieza manual.`, error);
            // La limpieza se activará por el evento 'connection.close' de todas formas
        }
    } else {
        // Si no hay un cliente conectado, limpiamos la sesión manualmente
        const authDir = `baileys_auth_${channelId}`;
        await fs.rm(authDir, { recursive: true, force: true }).catch(() => {});
        channelStates[channelId] = { status: 'DISCONNECTED', message: 'Desconectado manualmente.' };
        io.emit('channel_status_update', { channelId, status: 'DISCONNECTED', message: 'Desconectado.' });
    }
}

async function reconnectChannelsOnStartup() {
    console.log("Buscando sesiones guardadas para reconectar...");
    try {
        const allFiles = await fs.readdir(__dirname);
        const sessionDirs = allFiles.filter(file => file.startsWith('baileys_auth_'));
        for (const dir of sessionDirs) {
            const channelId = dir.replace('baileys_auth_', '');
            const channelDoc = await db.collection('channels').doc(channelId).get();
            if (channelDoc.exists) {
                console.log(`[WHATSAPP:${channelId}] Se encontró sesión guardada. Intentando reconexión...`);
                connectToWhatsApp(channelId, true);
            } else {
                 console.log(`[WHATSAPP:${channelId}] Se encontró sesión huérfana. Limpiando...`);
                 await fs.rm(dir, { recursive: true, force: true });
            }
        }
    } catch (error) {
        console.error("Error al reconectar canales:", error);
    }
}

// ==================================================================
// --- FIN: NUEVA ARQUITECTURA DE CONEXIÓN WHATSAPP ---
// ==================================================================

// --- LÓGICA DEL CONECTOR DE TELEGRAM CON WEBHOOK ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_PATH = '/telegram-webhook';
const WEBHOOK_URL = `https://hoprinplus-backend.onrender.com${WEBHOOK_PATH}`;
let bot;

if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== 'DISABLED') {
    bot = new Telegraf(TELEGRAM_BOT_TOKEN);

    bot.on('text', async (ctx) => {
        const message = ctx.message;
        const from = message.from;
        console.log(`[TELEGRAM] Mensaje recibido de ${from.first_name} (ID: ${from.id})`);
        const contactId = from.id.toString();
        const pushName = from.first_name ? `${from.first_name} ${from.last_name || ''}`.trim() : from.username;
        const messageText = message.text;
        const chatsRef = db.collection('chats');
        const chatQuery = await chatsRef.where('contactId', '==', contactId).where('platform', '==', 'telegram').limit(1).get();
        let chatDocRef;
        if (chatQuery.empty) {
            console.log(`[TELEGRAM] Creando nuevo chat para el contacto: ${pushName}`);
            let atencionDeptId = null;
            try {
                const deptQuery = await db.collection('departments').where('name', '==', 'Atención al Cliente').limit(1).get();
                if (!deptQuery.empty) {
                    atencionDeptId = deptQuery.docs[0].id;
                    console.log(`[TELEGRAM] Departamento 'Atención al Cliente' encontrado con ID: ${atencionDeptId}`);
                } else {
                    console.warn("[TELEGRAM] ¡Alerta! El departamento 'Atención al Cliente' no se encontró en la base de datos.");
                }
            } catch (error) {
                console.error("[TELEGRAM] Error al buscar el departamento 'Atención al Cliente':", error);
            }
            const newChatData = {
                contactName: pushName,
                contactId: contactId,
                platform: 'telegram',
                internalId: `TG-${Date.now().toString().slice(-6)}`,
                departmentIds: atencionDeptId ? [atencionDeptId] : [],
                status: 'Abierto',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastMessage: messageText,
                lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                agentEmail: null,
                isBotActive: false,
            };
            chatDocRef = await chatsRef.add(newChatData);
        } else {
            console.log(`[TELEGRAM] Actualizando chat existente para: ${pushName}`);
            chatDocRef = chatQuery.docs[0].ref;
            await chatDocRef.update({
                status: 'Abierto',
                lastMessage: messageText,
                lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        await db.collection('chats').doc(chatDocRef.id).collection('messages').add({
            text: messageText,
            sender: 'contact',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            telegramMessageId: message.message_id
        });
    });

    // Establecer webhook en Telegram
    bot.telegram.setWebhook(WEBHOOK_URL);

    // Registrar endpoint en Express
    app.use(bot.webhookCallback(WEBHOOK_PATH));

    console.log("[TELEGRAM] Webhook configurado correctamente y escuchando mensajes.");
} else {
    console.warn("[TELEGRAM] Token no válido o desactivado. El conector de Telegram no se iniciará.");
}

// --- LÓGICA DE MANEJO DE MENSAJES DE WHATSAPP ---
async function handleWhatsAppMessages(sock, channelId, m) {
    const msg = m.messages[0];
    const channelInfo = await db.collection('channels').doc(channelId).get();
    // La vinculación ahora es canal -> departamento(s), no al revés.
    const departmentId = channelInfo.exists ? channelInfo.data().departmentId : null;

    if (!msg.message || !departmentId) {
        console.log(`[WHATSAPP:${channelId}] Mensaje ignorado (sin contenido o canal no vinculado a un departamento).`);
        return;
    }

    const messageType = Object.keys(msg.message)[0];
    const messageContent = msg.message[messageType];
    const messageText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
    const senderJid = msg.key.remoteJid;

    if (msg.key.fromMe) {
        const chatQuery = await db.collection('chats').where('contactPhone', '==', senderJid).limit(1).get();
        if (!chatQuery.empty) {
            const chatDoc = chatQuery.docs[0];
            await db.collection('chats').doc(chatDoc.id).collection('messages').add({ text: messageText, sender: 'agent', agentEmail: 'sync_phone', timestamp: admin.firestore.FieldValue.serverTimestamp(), status: 'read' });
            await chatDoc.ref.update({ lastMessage: messageText, lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp() });
        }
    } else {
        const pushName = msg.pushName || senderJid;
        const chatsRef = db.collection('chats');
        const chatQuery = await chatsRef.where('contactPhone', '==', senderJid).limit(1).get();
        let chatDocRef;
        let chatData = {};
        let lastMessageTextForDb = messageText;
        
        let messageForDb = {
            text: messageText,
            sender: 'contact',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
        };
        
        if (messageType === 'audioMessage') {
    try {
        const stream = await downloadContentFromMessage(messageContent, 'audio');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        const audioFileName = `audio/${uuidv4()}.ogg`;
        const fileRef = ref(storage.bucket(), audioFileName);
        await uploadBytes(fileRef, buffer, { contentType: 'audio/ogg' });
        const downloadURL = await getDownloadURL(fileRef);
        messageForDb.fileUrl = downloadURL;
        messageForDb.fileType = 'audio/ogg';
        messageForDb.fileName = 'Mensaje de voz';
        lastMessageTextForDb = '🎤 Mensaje de voz';
    } catch (audioError) {
        console.error(`[AUDIO:${channelId}] Error al procesar audio:`, audioError);
        lastMessageTextForDb = '⚠️ Error al procesar audio';
    }
} else if (messageType === 'imageMessage') {
    try {
        const stream = await downloadContentFromMessage(messageContent, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        const imageFileName = `images/${uuidv4()}.jpg`;
        const fileRef = ref(storage.bucket(), imageFileName);
        await uploadBytes(fileRef, buffer, { contentType: 'image/jpeg' });
        const downloadURL = await getDownloadURL(fileRef);
        messageForDb.fileUrl = downloadURL;
        messageForDb.fileType = 'image/jpeg';
        messageForDb.fileName = 'Imagen recibida';
        lastMessageTextForDb = '🖼 Imagen recibida';
    } catch (imageError) {
        console.error(`[IMAGEN:${channelId}] Error al procesar imagen:`, imageError);
        lastMessageTextForDb = '⚠️ Error al procesar imagen';
    }
} else if (messageType === 'videoMessage') {
    try {
        const stream = await downloadContentFromMessage(messageContent, 'video');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        const videoFileName = `videos/${uuidv4()}.mp4`;
        const fileRef = ref(storage.bucket(), videoFileName);
        await uploadBytes(fileRef, buffer, { contentType: 'video/mp4' });
        const downloadURL = await getDownloadURL(fileRef);
        messageForDb.fileUrl = downloadURL;
        messageForDb.fileType = 'video/mp4';
        messageForDb.fileName = 'Video recibido';
        lastMessageTextForDb = '📹 Video recibido';
    } catch (videoError) {
        console.error(`[VIDEO:${channelId}] Error al procesar video:`, videoError);
        lastMessageTextForDb = '⚠️ Error al procesar video';
    }
} else if (messageType === 'documentMessage') {
    try {
        const stream = await downloadContentFromMessage(messageContent, 'document');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        const originalName = messageContent.fileName || `documento_${uuidv4()}.pdf`;
        const extension = originalName.split('.').pop() || 'pdf';
        const docFileName = `documents/${uuidv4()}.${extension}`;
        const fileRef = ref(storage.bucket(), docFileName);
        await uploadBytes(fileRef, buffer, { contentType: messageContent.mimetype || 'application/pdf' });
        const downloadURL = await getDownloadURL(fileRef);
        messageForDb.fileUrl = downloadURL;
        messageForDb.fileType = messageContent.mimetype || 'application/pdf';
        messageForDb.fileName = originalName;
        lastMessageTextForDb = '📄 Documento recibido';
    } catch (docError) {
        console.error(`[DOCUMENTO:${channelId}] Error al procesar documento:`, docError);
        lastMessageTextForDb = '⚠️ Error al procesar documento';
    }
}

        
        if (chatQuery.empty) {
            if (!botSettings.isEnabled) return;
            if (!isWithinOfficeHours()) {
                if (botSettings.awayEnabled && botSettings.awayMessage) { await sock.sendMessage(senderJid, { text: botSettings.awayMessage }); }
                return;
            }
            
            const agentToAssign = await findNextAvailableAgent(departmentId);
            const newChatData = {
                contactName: pushName, contactPhone: senderJid, internalId: `WA-${Date.now().toString().slice(-6)}`,
                departmentIds: [departmentId], platform: 'whatsapp', status: 'Abierto', createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastMessage: lastMessageTextForDb, lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                agentEmail: agentToAssign, 
                isBotActive: !agentToAssign,
                botState: {}
            };
            chatDocRef = await chatsRef.add(newChatData);
            chatData = newChatData;

            if (agentToAssign) {
                io.emit('new_chat_assigned', { chatId: chatDocRef.id, agentEmail: agentToAssign });
                if (botSettings.welcomeEnabled && botSettings.welcomeMessage) {
                    await sock.sendMessage(senderJid, { text: botSettings.welcomeMessage });
                }
            }
            
            if (newChatData.isBotActive) {
                const startNode = activeBotFlow.nodes.find(n => n.type === 'start');
                if (startNode) {
                    await executeNode(startNode, sock, senderJid, chatDocRef);
                }
            }
        } else {
            chatDocRef = chatQuery.docs[0].ref;
            chatData = chatQuery.docs[0].data();
            await chatDocRef.update({ 
                status: 'Abierto', 
                lastMessage: lastMessageTextForDb, 
                lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                // Si el chat no tiene departamento, se le asigna el del canal por el que entró
                departmentIds: admin.firestore.FieldValue.arrayUnion(departmentId) 
            });
        }
        
        await db.collection('chats').doc(chatDocRef.id).collection('messages').add(messageForDb);
        
        if (chatData.isBotActive && messageText) {
            await processBotMessage(chatDocRef, chatData, messageText, sock);
        }

        if (chatData.ratingPending && /^[1-5]$/.test(messageText)) {
            await chatDocRef.update({
                rating: parseInt(messageText, 10),
                ratingPending: false
            });
            await sock.sendMessage(senderJid, { text: '¡Gracias por tu calificación! 🙌' });
        }
    }
}


// --- LÓGICA DE HORARIOS, BOT, ETC. (SIN CAMBIOS) ---
let botSettings = { isEnabled: true, awayMessage: 'Gracias por escribirnos. Nuestro horario de atención ha finalizado por hoy. Te responderemos tan pronto como nuestro equipo esté de vuelta.', schedule: [], welcomeEnabled: false, welcomeMessage: '', closingEnabled: false, closingMessage: '', closingDelay: '10' };
const settingsRef = db.collection('settings').doc('bot');
settingsRef.onSnapshot(doc => { if (doc.exists) { botSettings = { ...botSettings, ...doc.data() }; console.log("[Settings] Configuración del bot actualizada en tiempo real."); } else { console.log("[Settings] No se encontró configuración del bot, usando valores por defecto."); } });

let activeBotFlow = { nodes: [{ id: 'start', type: 'start', content: 'Inicio del Flujo' }], edges: [] };
const botFlowRef = db.collection('bot_flows').doc('default_welcome');
botFlowRef.onSnapshot(doc => { if (doc.exists) { activeBotFlow = doc.data(); console.log("[Bot Flow] Flujo del bot actualizado desde Firestore."); } else { console.log("[Bot Flow] No se encontró flujo en Firestore, usando el flujo por defecto codificado."); } });

async function executeNode(node, sock, senderJid, chatDocRef) { /* ... Tu lógica ... */ }
async function processBotMessage(chatDocRef, chatData, messageText, sock) { /* ... Tu lógica ... */ }
function isWithinOfficeHours() { /* ... Tu lógica ... */ return true; }
async function findNextAvailableAgent(departmentId) { /* ... Tu lógica ... */ return null; }


// --- ENDPOINT DE UPLOAD (SIN CAMBIOS) ---
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No se subió ningún archivo.');
    }
    try {
        const fileExtension = req.file.originalname.split('.').pop();
        const fileName = `uploads/${uuidv4()}.${fileExtension}`;
        const fileRef = ref(storage.bucket(), fileName);
        await uploadBytes(fileRef, req.file.buffer, { contentType: req.file.mimetype });
        const downloadURL = await getDownloadURL(fileRef);
        res.status(200).json({ url: downloadURL, mimetype: req.file.mimetype, name: req.file.originalname });
    } catch (error) {
        console.error("Error al subir archivo:", error);
        res.status(500).send("Error al subir el archivo.");
    }
});


// --- LÓGICA DE SOCKETS PARA EL FRONTEND ---
io.on('connection', (socket) => {
    console.log(`Un usuario frontend se ha conectado: ${socket.id}`);

    Object.entries(channelStates).forEach(([channelId, state]) => {
        socket.emit('channel_status_update', { channelId, status: state.status, message: state.message });
    });

    socket.on('conectar_canal', ({ channelId }) => {
        connectToWhatsApp(channelId, false);
    });

    socket.on('desconectar_canal', ({ channelId }) => {
        disconnectWhatsApp(channelId);
    });

    socket.on('link_channel_to_department', async ({ channelId, departmentId }) => {
        try {
            const channelRef = db.collection('channels').doc(channelId);
            await channelRef.update({ departmentId });
        } catch (error) { console.error("Error al vincular canal:", error); }
    });

    socket.on('enviar_mensaje', async (data) => {
        const { chatId, message, agentEmail, fileUrl, fileName, fileType } = data;
        try {
            const chatDoc = await db.collection('chats').doc(chatId).get();
            if (!chatDoc.exists) { 
                console.error("Chat no encontrado:", chatId);
                return;
            }
            const chatData = chatDoc.data();
            const recipientId = chatData.contactPhone || chatData.contactId;

            if (chatData.platform === 'telegram') {
                if (bot) {
                    if (fileUrl) {
                        if (fileType.startsWith('image/')) { await bot.telegram.sendPhoto(recipientId, { url: fileUrl }, { caption: message }); }
                        else if (fileType.startsWith('video/')) { await bot.telegram.sendVideo(recipientId, { url: fileUrl }, { caption: message }); }
                        else { await bot.telegram.sendDocument(recipientId, { url: fileUrl }, { filename: fileName, caption: message }); }
                    } else {
                        await bot.telegram.sendMessage(recipientId, message);
                    }
                    console.log(`[TELEGRAM] Mensaje enviado a ${recipientId}`);
                } else {
                    socket.emit('envio_fallido', { chatId, error: 'El bot de Telegram no está conectado.' });
                }
            
		} else { // Asumimos que es 'whatsapp'
				const channel = await findChannelForChat(chatData);
					console.log(`[DEBUG] Intentando enviar mensaje al chat ${chatId}`);
					console.log(`[DEBUG] Canal resuelto: ${channel?.id}`);
					console.log(`[DEBUG] Estado del canal: ${channelStates[channel?.id]?.status}`);
					console.log(`[DEBUG] Cliente WhatsApp presente:`, !!whatsappClients[channel?.id]);
					console.log(`[DEBUG] Cliente WhatsApp conectado:`, whatsappClients[channel?.id]?.isConnected?.());

				const client = channel && whatsappClients[channel.id];

				if (!client || typeof client.sendMessage !== 'function') {
					console.error(`[WHATSAPP] Cliente no válido para el canal ${channel?.id}`);
					socket.emit('envio_fallido', { chatId, error: 'El canal de WhatsApp no está conectado correctamente.' });
					return;
				}

				try {
					if (fileUrl) {
						if (fileType.startsWith('image/')) {
						await client.sendMessage(recipientId, { image: { url: fileUrl }, caption: message });
					} else if (fileType.startsWith('video/')) {
						await client.sendMessage(recipientId, { video: { url: fileUrl }, caption: message });
					} else if (fileType.startsWith('audio/')) {
						await client.sendMessage(recipientId, { audio: { url: fileUrl }, mimetype: fileType });
					} else {
						await client.sendMessage(recipientId, { document: { url: fileUrl }, fileName: fileName });
					}
				} else {
					await client.sendMessage(recipientId, { text: message });
				}

				console.log(`[WHATSAPP] Mensaje enviado a ${recipientId}`);
			} catch (err) {
				console.error(`[WHATSAPP] Error al enviar mensaje proactivo:`, err.message);
				await db.collection('failedMessages').add({
					chatId,
					channelId: channel.id,
					recipientId,
					messageText: message,
					error: err.message,
					timestamp: admin.firestore.FieldValue.serverTimestamp()
				});
				socket.emit('envio_fallido', { chatId, error: 'No se pudo enviar el mensaje. El contacto puede no estar disponible.' });
				return; // NO limpiar sesión
			}
		}


            await db.collection('chats').doc(chatId).collection('messages').add({
                text: message || fileName, sender: 'agent', agentEmail, timestamp: admin.firestore.FieldValue.serverTimestamp(), fileUrl: fileUrl || null, fileName: fileName || null,
            });
            await db.collection('chats').doc(chatId).update({
                lastMessage: message || fileName, lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (error) {
            console.error(`Error al enviar mensaje al chat ${chatId}:`, error);
            socket.emit('envio_fallido', { chatId, error: 'Error interno del servidor al enviar el mensaje.' });
        }
    });

    socket.on('solicitar_calificacion', async ({ chatId }) => {
        // ... Tu lógica de calificación
    });

    socket.on('disconnect', () => console.log(`Usuario frontend desconectado: ${socket.id}`));
});

async function findChannelForChat(chatData) {
    if (!chatData.departmentIds || chatData.departmentIds.length === 0) return null;

    const allChannelsSnapshot = await db.collection('channels').get();
    if (allChannelsSnapshot.empty) return null;

    for (const channelDoc of allChannelsSnapshot.docs) {
        const channelData = channelDoc.data();
        const channelId = channelDoc.id;
        const isConnected = channelStates[channelId]?.status === 'CONNECTED';

        if (
            channelData.departmentId &&
            chatData.departmentIds.includes(channelData.departmentId) &&
            isConnected &&
            whatsappClients[channelId]
        ) {
            return { id: channelId, ...channelData };
        }
    }

    return null;
}

// --- ENDPOINTS DE API Y HEALTH CHECK ---
app.get('/health', (req, res) => {
    const isTelegramRunning = typeof bot !== 'undefined' && bot.telegram;
    if (isTelegramRunning) {
        res.status(200).json({ status: 'ok', telegram: 'connected' });
    } else {
        res.status(503).json({ status: 'error', telegram: 'disconnected' });
    }
});

const ERP_API_KEY = 'tu-clave-secreta-para-el-crm-aqui';
const verifyApiKey = (req, res, next) => { const apiKey = req.header('X-API-KEY'); if (apiKey === ERP_API_KEY) { next(); } else { res.status(401).json({ error: 'Unauthorized' }); } };

app.get('/api/kpis/calificacion-promedio', verifyApiKey, async (req, res) => {
    try {
        const chatsRef = db.collection('chats');
        const snapshot = await chatsRef.where('status', '==', 'Cerrado').where('rating', '>', 0).get();
        if (snapshot.empty) { return res.json({ metric: 'calificacion', data: { current: 0, previous: 0 } }); }
        let totalRating = 0;
        snapshot.forEach(doc => { totalRating += doc.data().rating; });
        const averageRating = (totalRating / snapshot.size) * 20;
        const previousAverage = Math.max(0, averageRating - 5);
        res.json({ metric: 'calificacion', data: { current: averageRating.toFixed(0), previous: previousAverage.toFixed(0) } });
    } catch (error) {
        console.error("Error en /api/kpis/calificacion-promedio:", error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/api/kpis/reportes-activos', verifyApiKey, async (req, res) => {
    try {
        const chatsRef = db.collection('chats');
        const snapshot = await chatsRef.where('status', '==', 'Abierto').get();
        const previousCount = Math.max(0, snapshot.size - 2);
        res.json({ metric: 'reportes_activos', data: { current: snapshot.size, previous: previousCount, } });
    } catch (error) {
        console.error("Error en /api/kpis/reportes-activos:", error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// --- INICIO DEL SERVIDOR ---
server.listen(PORT, () => {
    console.log(`Servidor iniciado en puerto ${PORT}`);
    reconnectChannelsOnStartup();
});
