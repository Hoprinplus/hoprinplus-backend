// --- server.js (Versión con Asignación Rotativa de Agentes) ---

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
const { getStorage } = require("firebase-admin/storage");
const NodeWebSocket = require('ws');
const { Telegraf } = require('telegraf');
const axios = require('axios');

const crmSentMessageIds = new Set();
const messageRateTracker = {};
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_MESSAGES = 10;


// --- Configuración de Firebase ---
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: `hoprinplus-chat.firebasestorage.app`
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
// --- INICIO: ARQUITECTURA DE CONEXIÓN WHATSAPP ---
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
		if (sock?.ws?.readyState === NodeWebSocket.OPEN || sock?.isConnected?.()) {
			console.log(`[WHATSAPP:${channelId}] El socket/cliente aún está activo. Evitando limpieza innecesaria.`);
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
		io.emit('channel_status_update', { channelId, status: 'DISCONNECTED', message: 'Canal desconectado.' });
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
                    console.log(`[WHATSAPP:${channelId}] Conexión cerrada, intentando reconexión automática...`);
                    await cleanup(false);
                    setTimeout(() => connectToWhatsApp(channelId, true), 5000);
				} else {
                    console.log(`[WHATSAPP:${channelId}] Conexión cerrada permanentemente (loggedOut/replaced).`);
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
        }
    }
    const authDir = `baileys_auth_${channelId}`;
    await fs.rm(authDir, { recursive: true, force: true }).catch(() => {});
    channelStates[channelId] = { status: 'DISCONNECTED', message: 'Desconectado manualmente.' };
    io.emit('channel_status_update', { channelId, status: 'DISCONNECTED', message: 'Desconectado.' });
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
// --- FIN: ARQUITECTURA DE CONEXIÓN WHATSAPP ---
// ==================================================================

// ==================================================================
// --- INICIO: LÓGICA DEL CONECTOR DE TELEGRAM ---
// ==================================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_PATH = '/telegram-webhook';
const WEBHOOK_URL = `https://hoprinplus-backend.onrender.com${WEBHOOK_PATH}`;
let bot;

async function processTelegramMessage(ctx, messageData) {
    const from = ctx.message.from;
    const contactId = from.id.toString();
    const pushName = from.first_name ? `${from.first_name} ${from.last_name || ''}`.trim() : (from.username || contactId);
    const telegramUsername = from.username || null;

    const chatsRef = db.collection('chats');
    const chatQuery = await chatsRef.where('contactId', '==', contactId).where('platform', '==', 'telegram').limit(1).get();
    
    let chatDocRef;
    if (chatQuery.empty) {
        console.log(`[TELEGRAM] Creando nuevo chat para: ${pushName}`);
        let atencionDeptId = null;
        try {
            const deptQuery = await db.collection('departments').where('name', '==', 'Atención al Cliente').limit(1).get();
            if (!deptQuery.empty) atencionDeptId = deptQuery.docs[0].id;
        } catch (error) {
            console.error("[TELEGRAM] Error al buscar depto 'Atención al Cliente':", error);
        }
        
        // ▼▼▼ INICIO: LÓGICA DE ASIGNACIÓN AUTOMÁTICA PARA TELEGRAM ▼▼▼
        const agentToAssign = await findNextAvailableAgent(atencionDeptId);
        // ▲▲▲ FIN: LÓGICA DE ASIGNACIÓN AUTOMÁTICA PARA TELEGRAM ▲▲▲

        const newChatData = {
            contactName: pushName, contactId, telegramUsername,
            platform: 'telegram',
            internalId: `TG-${Date.now().toString().slice(-6)}`,
            departmentIds: atencionDeptId ? [atencionDeptId] : [],
            status: 'Abierto', createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastMessage: messageData.lastMessage,
            lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            agentEmail: agentToAssign, // <-- CAMBIO: Se asigna el agente aquí
            isBotActive: false,
        };
        chatDocRef = await chatsRef.add(newChatData);
    } else {
        console.log(`[TELEGRAM] Actualizando chat existente para: ${pushName}`);
        chatDocRef = chatQuery.docs[0].ref;
        await chatDocRef.update({
            status: 'Abierto',
            lastMessage: messageData.lastMessage,
            lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            telegramUsername
        });
    }
    
    await db.collection('chats').doc(chatDocRef.id).collection('messages').add({
        ...messageData.dbMessage,
        sender: 'contact',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        telegramMessageId: ctx.message.message_id
    });
}

async function handleTelegramMedia(ctx, fileId, mimeType, originalFileName, lastMessageText) {
    try {
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const response = await axios({ url: fileLink.href, responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');

        const fileExtension = originalFileName.split('.').pop() || 'tmp';
        const storageFileName = `uploads/${uuidv4()}.${fileExtension}`;
        const fileRef = storage.bucket().file(storageFileName);

        await fileRef.save(buffer, { contentType: mimeType });
        await fileRef.makePublic();
        const downloadURL = fileRef.publicUrl();

        await processTelegramMessage(ctx, {
            lastMessage: lastMessageText,
            dbMessage: {
                text: ctx.message.caption || '',
                fileUrl: downloadURL,
                fileType: mimeType,
                fileName: originalFileName
            }
        });
    } catch (error) {
        console.error(`[TELEGRAM] Error procesando archivo (${originalFileName}):`, error);
    }
}

if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== 'DISABLED') {
    bot = new Telegraf(TELEGRAM_BOT_TOKEN);

    bot.on('text', async (ctx) => {
        await processTelegramMessage(ctx, {
            lastMessage: ctx.message.text,
            dbMessage: { text: ctx.message.text }
        });
    });

    bot.on('photo', async (ctx) => {
        const photo = ctx.message.photo.pop();
        await handleTelegramMedia(ctx, photo.file_id, 'image/jpeg', `photo_${photo.file_unique_id}.jpg`, `🖼️ ${ctx.message.caption || 'Imagen'}`);
    });

    bot.on('document', async (ctx) => {
        const doc = ctx.message.document;
        await handleTelegramMedia(ctx, doc.file_id, doc.mime_type, doc.file_name, `📄 ${doc.file_name}`);
    });

    bot.on('voice', async (ctx) => {
        const voice = ctx.message.voice;
        await handleTelegramMedia(ctx, voice.file_id, voice.mime_type, `voice_${voice.file_unique_id}.ogg`, '🎤 Mensaje de voz');
    });

    bot.on('video', async (ctx) => {
        const video = ctx.message.video;
        await handleTelegramMedia(ctx, video.file_id, video.mime_type, video.file_name || `video_${video.file_unique_id}.mp4`, `📹 ${ctx.message.caption || 'Video'}`);
    });
    
    bot.telegram.setWebhook(WEBHOOK_URL);
    app.use(bot.webhookCallback(WEBHOOK_PATH));
    console.log("[TELEGRAM] Webhook configurado correctamente y escuchando mensajes.");
} else {
    console.warn("[TELEGRAM] Token no válido o desactivado. El conector de Telegram no se iniciará.");
}

// ==================================================================
// --- FIN: LÓGICA DEL CONECTOR DE TELEGRAM ---
// ==================================================================

// --- LÓGICA DE MANEJO DE MENSAJES DE WHATSAPP ---
async function handleWhatsAppMessages(sock, channelId, m) {
    const msg = m.messages[0];
    const channelInfo = await db.collection('channels').doc(channelId).get();
    const departmentId = channelInfo.exists ? channelInfo.data().departmentId : null;

    if (!msg.message || !departmentId) {
        return;
    }

    if (msg.key.fromMe && crmSentMessageIds.has(msg.key.id)) {
        return;
    }

    const messageType = Object.keys(msg.message)[0];
    const messageContent = msg.message[messageType];
    const senderJid = msg.key.remoteJid;
	
	if (messageRateTracker[senderJid]) {
        messageRateTracker[senderJid] = messageRateTracker[senderJid].filter(ts => Date.now() - ts < RATE_LIMIT_WINDOW_MS);
        messageRateTracker[senderJid].push(Date.now());
        if (messageRateTracker[senderJid].length > RATE_LIMIT_MAX_MESSAGES) {
            console.warn(`[WHATSAPP:${channelId}] Ignorando mensaje por spam: ${senderJid}`);
            return;
        }
    } else {
        messageRateTracker[senderJid] = [Date.now()];
    }
	
	if (!senderJid || !senderJid.endsWith('@s.whatsapp.net')) {
        console.warn(`[WHATSAPP:${channelId}] Ignorando mensaje de origen no válido: ${senderJid}`);
        return;
	}

    const messageText = (msg.message.conversation || msg.message.extendedTextMessage?.text || messageContent.caption || '').trim();
    let lastMessageTextForDb = messageText;
    let messageForDb = { 
        text: messageText, 
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const mediaTypes = {
        'audioMessage': { type: 'audio', ext: 'ogg', defaultName: 'Mensaje de voz', icon: '🎤' },
        'imageMessage': { type: 'image', ext: 'jpg', defaultName: 'Imagen', icon: '🖼️' },
        'videoMessage': { type: 'video', ext: 'mp4', defaultName: 'Video', icon: '📹' },
        'documentMessage': { type: 'document', ext: 'pdf', defaultName: 'Documento', icon: '📄' }
    };
    if (mediaTypes[messageType]) {
        const mediaInfo = mediaTypes[messageType];
        const originalName = messageContent.fileName || `${mediaInfo.defaultName}.${mediaInfo.ext}`;
        lastMessageTextForDb = `${mediaInfo.icon} ${messageText || originalName}`;
        if (!msg.key.fromMe) {
            try {
                const stream = await downloadContentFromMessage(messageContent, mediaInfo.type);
                let buffer = Buffer.from([]);
                for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
                
                const extension = originalName.split('.').pop() || mediaInfo.ext;
                const fileName = `uploads/${uuidv4()}.${extension}`;
                const fileRef = storage.bucket().file(fileName);
                await fileRef.save(buffer, { contentType: messageContent.mimetype || 'application/octet-stream' });
                await fileRef.makePublic();
                
                messageForDb.fileUrl = fileRef.publicUrl();
                messageForDb.fileType = messageContent.mimetype || 'application/octet-stream';
                messageForDb.fileName = originalName;
            } catch (mediaError) {
                console.error(`[${mediaInfo.type.toUpperCase()}:${channelId}] Error al procesar archivo entrante:`, mediaError);
                lastMessageTextForDb = `⚠️ Error al procesar ${mediaInfo.defaultName.toLowerCase()}`;
            }
        }
    }

    if (msg.key.fromMe) {
        const chatQuery = await db.collection('chats').where('contactPhone', '==', senderJid).limit(1).get();
        if (!chatQuery.empty) {
            const chatDoc = chatQuery.docs[0];
            messageForDb.sender = 'agent';
            messageForDb.agentEmail = 'sync_phone';
            messageForDb.status = 'read';
            
            await db.collection('chats').doc(chatDoc.id).collection('messages').add(messageForDb);
            await chatDoc.ref.update({ 
                lastMessage: lastMessageTextForDb, 
                lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp() 
            });
        }
    } else {
        const pushName = msg.pushName || senderJid;
        const chatsRef = db.collection('chats');
        const chatQuery = await chatsRef.where('contactPhone', '==', senderJid).limit(1).get();
        let chatDocRef;
        let chatData;
        
        messageForDb.sender = 'contact';

        if (chatQuery.empty) {
            if (!botSettings.isEnabled) return;
            if (!isWithinOfficeHours()) {
                if (botSettings.awayEnabled && botSettings.awayMessage) { await sock.sendMessage(senderJid, { text: botSettings.awayMessage }); }
                return;
            }
            
            // ▼▼▼ INICIO: LÓGICA DE ASIGNACIÓN AUTOMÁTICA ▼▼▼
            const agentToAssign = await findNextAvailableAgent(departmentId);
            // ▲▲▲ FIN: LÓGICA DE ASIGNACIÓN AUTOMÁTICA ▲▲▲
            
            const newChatData = {
                contactName: pushName, contactPhone: senderJid, internalId: `WA-${Date.now().toString().slice(-6)}`,
                departmentIds: [departmentId], platform: 'whatsapp', status: 'Abierto', createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastMessage: lastMessageTextForDb, lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                agentEmail: agentToAssign, // <-- CAMBIO: Se asigna el agente aquí
                isBotActive: !agentToAssign, 
                botState: {}
            };
            
			if (!/^\d{7,15}@s\.whatsapp\.net$/.test(senderJid)) { return; }
		
			chatDocRef = await chatsRef.add(newChatData);
            chatData = newChatData;

            if (agentToAssign) {
                console.log(`[ASIGNACIÓN] Nuevo chat de ${pushName} asignado a ${agentToAssign}`);
                io.emit('new_chat_assigned', { chatId: chatDocRef.id, agentEmail: agentToAssign });
                if (botSettings.welcomeEnabled && botSettings.welcomeMessage) {
                    await sock.sendMessage(senderJid, { text: botSettings.welcomeMessage });
                }
            }
            
            if (newChatData.isBotActive) {
                const startNode = activeBotFlow.nodes.find(n => n.type === 'start');
                if (startNode) { await executeNode(startNode, sock, senderJid, chatDocRef); }
            }
        } else {
            chatDocRef = chatQuery.docs[0].ref;
            chatData = chatQuery.docs[0].data();
            await chatDocRef.update({ 
                status: 'Abierto', 
                lastMessage: lastMessageTextForDb, 
                lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                departmentIds: admin.firestore.FieldValue.arrayUnion(departmentId) 
            });
        }
        
        await db.collection('chats').doc(chatDocRef.id).collection('messages').add(messageForDb);
        
        if (chatData.isBotActive && messageText) {
            await processBotMessage(chatDocRef, chatData, messageText, sock);
        }
        if (chatData.ratingPending && /^[1-5]$/.test(messageText)) {
            await chatDocRef.update({ rating: parseInt(messageText, 10), ratingPending: false });
            await sock.sendMessage(senderJid, { text: '¡Gracias por tu calificación! 🙌' });
        }
    }
}

// --- LÓGICA DE HORARIOS, BOT, ETC. ---
let botSettings = { isEnabled: true, awayMessage: 'Gracias por escribirnos. Nuestro horario de atención ha finalizado por hoy. Te responderemos tan pronto como nuestro equipo esté de vuelta.', schedule: [], welcomeEnabled: false, welcomeMessage: '', closingEnabled: false, closingMessage: '', closingDelay: '10' };
const settingsRef = db.collection('settings').doc('bot');
settingsRef.onSnapshot(doc => { if (doc.exists) { botSettings = { ...botSettings, ...doc.data() }; console.log("[Settings] Configuración del bot actualizada en tiempo real."); } else { console.log("[Settings] No se encontró configuración del bot, usando valores por defecto."); } });

let activeBotFlow = { nodes: [{ id: 'start', type: 'start', content: 'Inicio del Flujo' }], edges: [] };
const botFlowRef = db.collection('bot_flows').doc('default_welcome');
botFlowRef.onSnapshot(doc => { if (doc.exists) { activeBotFlow = doc.data(); console.log("[Bot Flow] Flujo del bot actualizado desde Firestore."); } else { console.log("[Bot Flow] No se encontró flujo en Firestore, usando el flujo por defecto codificado."); } });

async function executeNode(node, sock, senderJid, chatDocRef) { /* ... Tu lógica ... */ }
async function processBotMessage(chatDocRef, chatData, messageText, sock) { /* ... Tu lógica ... */ }
function isWithinOfficeHours() { /* ... Tu lógica ... */ return true; }

// ▼▼▼ INICIO: NUEVA FUNCIÓN DE ASIGNACIÓN ROTATIVA (ROUND-ROBIN) ▼▼▼

// Variable en memoria para rastrear el último agente asignado por departamento
// ▼▼▼ REEMPLAZA LA FUNCIÓN COMPLETA CON ESTA VERSIÓN CORREGIDA ▼▼▼

// Variable en memoria para rastrear el último agente asignado por departamento
const lastAssignedAgentIndex = {};

/**
 * Encuentra el siguiente agente disponible en un departamento usando una estrategia rotativa.
 * @param {string} departmentId - El ID del departamento de Firestore.
 * @returns {Promise<string|null>} El email del agente asignado o null si no hay ninguno disponible.
 */
async function findNextAvailableAgent(departmentId) {
    if (!departmentId) {
        console.warn("[ASIGNACIÓN] Se intentó asignar un chat sin departmentId.");
        return null;
    }

    try {
        // --- INICIO DE LA CORRECCIÓN ---
        // 1. Obtener el nombre del departamento a partir de su ID.
        const departmentDoc = await db.collection('departments').doc(departmentId).get();
        if (!departmentDoc.exists) {
            console.error(`[ASIGNACIÓN] No se encontró el departamento con ID: ${departmentId}`);
            return null;
        }
        const departmentName = departmentDoc.data().name;

        // 2. Obtener todos los agentes disponibles usando el NOMBRE del departamento.
        const agentsRef = db.collection('agents');
        const snapshot = await agentsRef
            .where('department', '==', departmentName) // <-- CAMBIO CLAVE: Usamos el campo 'department' (nombre)
            .where('status', '==', 'Disponible')
            .get();
        // --- FIN DE LA CORRECCIÓN ---

        if (snapshot.empty) {
            console.log(`[ASIGNACIÓN] No se encontraron agentes disponibles para el departamento ${departmentName}.`);
            return null;
        }

        const availableAgents = snapshot.docs.map(doc => doc.data());
        
        // 3. Determinar el índice del próximo agente a asignar (lógica rotativa).
        if (lastAssignedAgentIndex[departmentId] === undefined) {
            lastAssignedAgentIndex[departmentId] = -1;
        }

        const nextIndex = (lastAssignedAgentIndex[departmentId] + 1) % availableAgents.length;
        lastAssignedAgentIndex[departmentId] = nextIndex;

        const agentToAssign = availableAgents[nextIndex];
        
        console.log(`[ASIGNACIÓN] Próximo agente en la rotación para ${departmentName}: ${agentToAssign.email} (Índice: ${nextIndex})`);

        return agentToAssign.email;

    } catch (error) {
        console.error(`[ASIGNACIÓN] Error crítico al buscar agente disponible para ${departmentId}:`, error);
        return null;
    }
}
// ▲▲▲ FIN: NUEVA FUNCIÓN DE ASIGNACIÓN ROTATIVA (ROUND-ROBIN) ▲▲▲


app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No se subió ningún archivo.');
    }
    try {
        const fileExtension = req.file.originalname.split('.').pop();
        const fileName = `uploads/${uuidv4()}.${fileExtension}`;
        const fileRef = storage.bucket().file(fileName);

        await fileRef.save(req.file.buffer, { contentType: req.file.mimetype });
        await fileRef.makePublic();
        const downloadURL = fileRef.publicUrl();

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

    socket.on('conectar_canal', ({ channelId }) => connectToWhatsApp(channelId, false));
    socket.on('desconectar_canal', ({ channelId }) => disconnectWhatsApp(channelId));

    socket.on('link_channel_to_department', async ({ channelId, departmentId }) => {
        try {
            await db.collection('channels').doc(channelId).update({ departmentId });
        } catch (error) { console.error("Error al vincular canal:", error); }
    });

    socket.on('get_all_channel_statuses', () => {
        Object.entries(channelStates).forEach(([channelId, state]) => {
            socket.emit('channel_status_update', { channelId, status: state.status, message: state.message });
        });
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
                    const caption = message || '';
                    if (fileUrl) {
                        if (fileType.startsWith('image/')) { await bot.telegram.sendPhoto(recipientId, { url: fileUrl }, { caption }); }
                        else if (fileType.startsWith('video/')) { await bot.telegram.sendVideo(recipientId, { url: fileUrl }, { caption }); }
                        else if (fileType.startsWith('audio/')) { await bot.telegram.sendAudio(recipientId, { url: fileUrl }, { caption }); }
                        else { await bot.telegram.sendDocument(recipientId, { url: fileUrl, filename: fileName }, { caption }); }
                    } else {
                        await bot.telegram.sendMessage(recipientId, message);
                    }
                    console.log(`[TELEGRAM] Mensaje enviado a ${recipientId}`);
                } else {
                    socket.emit('envio_fallido', { chatId, error: 'El bot de Telegram no está conectado.' });
                }
            
		    } else { // Asumimos 'whatsapp'
				const channel = await findChannelForChat(chatData);
				const client = channel && whatsappClients[channel.id];

				if (!client || typeof client.sendMessage !== 'function') {
					socket.emit('envio_fallido', { chatId, error: 'El canal de WhatsApp no está conectado.' });
					return;
				}

				try {
                    let sentMessage;
                    const caption = message || '';
					if (fileUrl) {
                        let content;
						if (fileType.startsWith('image/')) {
						    content = { image: { url: fileUrl }, caption };
					    } else if (fileType.startsWith('video/')) {
						    content = { video: { url: fileUrl }, caption };
					    } else if (fileType.startsWith('audio/')) {
						    content = { audio: { url: fileUrl }, mimetype: fileType };
					    } else {
						    content = { document: { url: fileUrl }, fileName: fileName };
					    }
                        sentMessage = await client.sendMessage(recipientId, content);
				    } else {
					    sentMessage = await client.sendMessage(recipientId, { text: message });
				    }

                    if (sentMessage) {
                        crmSentMessageIds.add(sentMessage.key.id);
                        setTimeout(() => crmSentMessageIds.delete(sentMessage.key.id), 60000);
                    }

				    console.log(`[WHATSAPP] Mensaje enviado a ${recipientId}`);
			    } catch (err) {
				    console.error(`[WHATSAPP] Error al enviar mensaje:`, err.message);
				    await db.collection('failedMessages').add({
					    chatId, channelId: channel.id, recipientId, messageText: message,
					    error: err.message, timestamp: admin.firestore.FieldValue.serverTimestamp()
				    });
				    socket.emit('envio_fallido', { chatId, error: 'No se pudo enviar el mensaje.' });
			    }
		    }

            const lastMessageText = message || fileName || 'Archivo adjunto';
            await db.collection('chats').doc(chatId).collection('messages').add({
                text: lastMessageText, sender: 'agent', agentEmail, timestamp: admin.firestore.FieldValue.serverTimestamp(), fileUrl: fileUrl || null, fileName: fileName || null,
            });
            await db.collection('chats').doc(chatId).update({
                lastMessage: lastMessageText, lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (error) {
            console.error(`Error al enviar mensaje al chat ${chatId}:`, error);
            socket.emit('envio_fallido', { chatId, error: 'Error interno del servidor.' });
        }
    });
    
    socket.on('solicitar_calificacion', async ({ chatId }) => { /* ... Tu lógica ... */ });
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
