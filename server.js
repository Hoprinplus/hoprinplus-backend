// --- server.js (Versión Final y Completa) ---

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

// Archivo: server.js -> Reemplaza esta función completa

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

        // --- INICIO DE LA MODIFICACIÓN (Listener de Reacciones) ---
        sock.ev.on('messages.reaction', async (reactionData) => {
            try {
                const { reaction, key } = reactionData.messages[0];
                const reactionEmoji = reaction.text;
                
                // Ignorar si no es una reacción que nos interesa
                if (!['👍', '👎'].includes(reactionEmoji)) {
                    return;
                }
                
                // El ID del mensaje al que se reaccionó
                const reactedMessageId = key.id; 
                
                // Buscar si este ID de mensaje coincide con un 'ratingMessageId' en algún chat
                const chatsRef = db.collection('chats');
                const chatQuery = await chatsRef
                    .where('ratingMessageId', '==', reactedMessageId)
                    .limit(1)
                    .get();

                if (!chatQuery.empty) {
                    const chatDoc = chatQuery.docs[0];
                    const chatId = chatDoc.id;
                    const ratingValue = (reactionEmoji === '👍') ? 'positive' : 'negative';

                    // Actualizar el chat con la calificación y borrar el ID para evitar duplicados
                    await chatDoc.ref.update({
                        rating: ratingValue, // Guardamos 'positive' o 'negative'
                        ratingMessageId: null, // Limpiamos el ID
                        ratingPending: false // Marcamos como calificado
                    });
                    
                    console.log(`[CALIFICACIÓN] Calificación '${ratingValue}' registrada para el chat ${chatId}.`);
                }
            } catch (error) {
                console.error(`[CALIFICACIÓN] Error al procesar reacción de WhatsApp:`, error);
            }
        });
        // --- FIN DE LA MODIFICACIÓN ---


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
    delete whatsappClients[channelId];
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
            if (channelDoc.exists && channelDoc.data().type === 'whatsapp') {
                console.log(`[WHATSAPP:${channelId}] Se encontró sesión guardada. Intentando reconexión...`);
                connectToWhatsApp(channelId, true);
            } else {
                 console.log(`[WHATSAPP:${channelId}] Se encontró sesión huérfana o no es de WhatsApp. Limpiando...`);
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
const WEBHOOK_PATH = `/telegram-webhook/${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = `https://hoprinplus-backend.onrender.com${WEBHOOK_PATH}`;
let bot;
let telegramChannelId = null;

// Buscamos el ID del canal de Telegram al iniciar
db.collection('channels').where('type', '==', 'telegram').limit(1).get().then(snapshot => {
    if (!snapshot.empty) {
        telegramChannelId = snapshot.docs[0].id;
        console.log(`[TELEGRAM] ID del canal de Telegram encontrado: ${telegramChannelId}`);
    }
}).catch(err => console.error("[TELEGRAM] Error buscando canal de Telegram:", err));

async function checkTelegramHealth() {
    if (bot && telegramChannelId) {
        try {
            const botInfo = await bot.telegram.getMe();
            if (botInfo) {
                channelStates[telegramChannelId] = { status: 'CONNECTED', message: `Conectado como @${botInfo.username}` };
            }
        } catch (error) {
            console.error("[TELEGRAM] Health check fallido:", error.message);
            channelStates[telegramChannelId] = { status: 'DISCONNECTED', message: 'Token inválido o sin conexión.' };
        }
    }
}

async function processTelegramMessage(ctx, messageData) {
    const from = ctx.message.from;
    const contactId = from.id.toString();
    const pushName = from.first_name ? `${from.first_name} ${from.last_name || ''}`.trim() : (from.username || contactId);
    const telegramUsername = from.username || null;
    
    // --- INICIO DE LA CORRECCIÓN ---
    // Obtenemos el ID del departamento de "Atención al Cliente" al principio
    let atencionDeptId = null;
    try {
        const deptQuery = await db.collection('departments').where('name', '==', 'Atención al Cliente').limit(1).get();
        if (!deptQuery.empty) atencionDeptId = deptQuery.docs[0].id;
    } catch (error) {
        console.error("[TELEGRAM] Error al buscar depto 'Atención al Cliente':", error);
    }
    if (!atencionDeptId) {
        console.error("[TELEGRAM] No se pudo encontrar el ID del departamento 'Atención al Cliente'. No se puede procesar el mensaje.");
        return;
    }

    const chatsRef = db.collection('chats');
    // Ahora buscamos un chat que coincida con el ID de contacto, la plataforma Y el departamento.
    const chatQuery = await chatsRef
        .where('contactId', '==', contactId)
        .where('platform', '==', 'telegram')
        .where('departmentIds', 'array-contains', atencionDeptId)
        .limit(1).get();
    // --- FIN DE LA CORRECCIÓN ---
    
    let chatDocRef;
    if (chatQuery.empty) {
        console.log(`[TELEGRAM] Creando nuevo chat para: ${pushName}`);
        const agentToAssign = await findNextAvailableAgent(atencionDeptId);
        const newChatData = {
            contactName: pushName, contactId, telegramUsername,
            platform: 'telegram',
            internalId: `TG-${Date.now().toString().slice(-6)}`,
            departmentIds: [atencionDeptId], // Usamos el ID que ya buscamos
            status: 'Abierto', createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastMessage: messageData.lastMessage,
            lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            lastMessageSender: 'contact', 
            agentEmail: agentToAssign,
            isBotActive: false,
        };
        chatDocRef = await chatsRef.add(newChatData);
    } else {
        console.log(`[TELEGRAM] Actualizando chat existente para: ${pushName}`);
        chatDocRef = chatQuery.docs[0].ref;
        const chatData = chatQuery.docs[0].data();
        if (chatData.agentEmail) {
            const agentQuery = await db.collection('agents').where('email', '==', chatData.agentEmail).limit(1).get();
            if (!agentQuery.empty && agentQuery.docs[0].data().status === 'Ausente') {
                await chatDocRef.update({ agentEmail: null });
                console.log(`[REASIGNACIÓN] Chat de Telegram ${chatDocRef.id} desasignado del agente ausente ${chatData.agentEmail}.`);
            }
        }
		await chatDocRef.update({
            status: 'Abierto',
            lastMessage: messageData.lastMessage,
            lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            lastMessageSender: 'contact', 
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

// Archivo: server.js -> Reemplaza esta función completa

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

        // --- INICIO DE LA MODIFICACIÓN (Opción C - Telegram Media) ---
        // Construimos el objeto dbMessage primero
        const dbMessage = {
            text: ctx.message.caption || '',
            fileUrl: downloadURL,
            fileType: mimeType,
            fileName: originalFileName
        };

        // Revisamos si es una respuesta
        if (ctx.message.reply_to_message && bot.botInfo) {
            try {
                const quotedMsg = ctx.message.reply_to_message;
                const quotedText = quotedMsg.text || quotedMsg.caption || (quotedMsg.document ? `📄 ${quotedMsg.document.file_name}` : (quotedMsg.photo ? '🖼️ Imagen' : 'Mensaje adjunto'));
                const quotedSender = (quotedMsg.from.id === bot.botInfo.id) ? 'agent' : 'contact';
                
                dbMessage.quotedMessage = {
                    text: quotedText,
                    sender: quotedSender
                };
            } catch (quoteError) {
                 console.error(`[TELEGRAM] Error al procesar quotedMessage multimedia:`, quoteError.message);
            }
        }

        // Enviamos el objeto dbMessage completo
        await processTelegramMessage(ctx, {
            lastMessage: lastMessageText,
            dbMessage: dbMessage 
        });
        // --- FIN DE LA MODIFICACIÓN ---

    } catch (error) {
        // (El logging de error que añadimos en el paso anterior)
        console.error(`[TELEGRAM] Error procesando archivo (${originalFileName}) de contactId ${ctx.message.from.id}:`, error.message, error.stack);
    }
}

if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== 'DISABLED') {
    bot = new Telegraf(TELEGRAM_BOT_TOKEN);

    bot.on('text', async (ctx) => {
        // 1. Preparamos el objeto messageData
        const messageData = {
            lastMessage: ctx.message.text,
            dbMessage: { text: ctx.message.text }
        };
        
        // 2. Revisamos si es una respuesta y MODIFICAMOS messageData si es necesario
        if (ctx.message.reply_to_message && bot.botInfo) {
            try {
                const quotedMsg = ctx.message.reply_to_message;
                const quotedText = quotedMsg.text || quotedMsg.caption || (quotedMsg.document ? `📄 ${quotedMsg.document.file_name}` : (quotedMsg.photo ? '🖼️ Imagen' : 'Mensaje adjunto'));
                const quotedSender = (quotedMsg.from.id === bot.botInfo.id) ? 'agent' : 'contact';
                
                // Añadimos la cita al objeto dbMessage existente
                messageData.dbMessage.quotedMessage = {
                    text: quotedText,
                    sender: quotedSender
                };
            } catch (quoteError) {
                console.error(`[TELEGRAM] Error al procesar quotedMessage de texto:`, quoteError.message);
            }
        }
        
        // 3. Llamamos a processTelegramMessage UNA SOLA VEZ, al final,
        // usando el objeto messageData (que puede o no tener una cita).
        await processTelegramMessage(ctx, messageData);
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
    
    app.use(bot.webhookCallback(WEBHOOK_PATH));
    bot.telegram.setWebhook(WEBHOOK_URL).then(() => {
        console.log("[TELEGRAM] Webhook configurado correctamente y escuchando mensajes.");
        checkTelegramHealth();
    }).catch(err => console.error("[TELEGRAM] Error al configurar webhook:", err));

} else {
    console.warn("[TELEGRAM] Token no válido o desactivado. El conector de Telegram no se iniciará.");
}

// Archivo: server.js -> Reemplaza esta función completa (Líneas ~377 a ~583)

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

    // --- Rate Limiting y Validación de JID (Sin cambios) ---
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
    // --- Fin Rate Limiting ---

    const messageText = (msg.message.conversation || msg.message.extendedTextMessage?.text || messageContent.caption || '').trim();
    let lastMessageTextForDb = messageText;
    let messageForDb = {
        text: messageText,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    // --- Captura de Citas (Sin cambios) ---
	const contextInfo = messageContent?.contextInfo;
    if (contextInfo?.quotedMessage) {
        try {
            const quotedMsg = contextInfo.quotedMessage;
            const quotedSenderJid = contextInfo.participant;
            const quotedSender = (quotedSenderJid === sock.user.id) ? 'agent' : 'contact'; // Comparar directamente con sock.user.id
            const quotedText = quotedMsg.conversation ||
                               quotedMsg.extendedTextMessage?.text ||
                               (quotedMsg.imageMessage?.caption) ||
                               (quotedMsg.videoMessage?.caption) ||
                               (quotedMsg.documentMessage?.fileName) ||
                               (quotedMsg.audioMessage ? '🎤 Audio' : 'Archivo adjunto');
            messageForDb.quotedMessage = { text: quotedText, sender: quotedSender };
        } catch (quoteError) {
            console.error(`[WHATSAPP:${channelId}] Error al procesar quotedMessage:`, quoteError.message);
        }
    }
    // --- Fin Captura de Citas ---

    // --- Procesamiento de Archivos Multimedia (Sin cambios, incluye logging mejorado) ---
    const mediaTypes = { 'audioMessage': { type: 'audio', ext: 'ogg', defaultName: 'Mensaje de voz', icon: '🎤' }, 'imageMessage': { type: 'image', ext: 'jpg', defaultName: 'Imagen', icon: '🖼️' }, 'videoMessage': { type: 'video', ext: 'mp4', defaultName: 'Video', icon: '📹' }, 'documentMessage': { type: 'document', ext: 'pdf', defaultName: 'Documento', icon: '📄' } };
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
                console.error(`[${mediaInfo.type.toUpperCase()}:${channelId}] Error procesando archivo entrante para msg ID ${msg.key.id}:`, mediaError.message, mediaError.stack);
                lastMessageTextForDb = `⚠️ Error procesando ${mediaInfo.defaultName.toLowerCase()}`;
                messageForDb.fileUrl = null;
                messageForDb.fileType = messageContent.mimetype || 'application/octet-stream';
                messageForDb.fileName = originalName;
                messageForDb.text = `Error al procesar: ${originalName || mediaInfo.defaultName}`;
            }
        }
    }
    // --- Fin Procesamiento Multimedia ---


    // --- Sincronización de mensajes enviados desde el teléfono (Sin cambios) ---
    if (msg.key.fromMe) {
        const chatQuery = await db.collection('chats').where('contactPhone', '==', senderJid).limit(1).get();
        if (!chatQuery.empty) {
            const chatDoc = chatQuery.docs[0];
            messageForDb.sender = 'agent';
            messageForDb.agentEmail = 'sync_phone';
            messageForDb.status = 'read';
            await db.collection('chats').doc(chatDoc.id).collection('messages').add(messageForDb);
            await chatDoc.ref.update({ lastMessage: lastMessageTextForDb, lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(), lastMessageSender: 'agent' });
        }
    // --- Fin Sincronización Teléfono ---

    } else { // Mensaje entrante de un cliente
        const pushName = msg.pushName || senderJid;
        const chatsRef = db.collection('chats');

        // Buscar chat existente para este teléfono Y departamento
        const chatQuery = await chatsRef.where('contactPhone', '==', senderJid).where('departmentIds', 'array-contains', departmentId).limit(1).get();

        let chatDocRef;
        let chatData;
        messageForDb.sender = 'contact';

        // --- LÓGICA PARA CHAT NUEVO (if chatQuery.empty) ---
        if (chatQuery.empty) {
            const deptDoc = await db.collection('departments').doc(departmentId).get();
            const departmentName = deptDoc.exists ? deptDoc.data().name : null;
            let agentToAssign = null; // Por defecto no se asigna agente

            // Verificamos si estamos DENTRO del horario laboral
            const withinOfficeHours = isWithinOfficeHours();

            // Lógica de Mensaje de Ausente (Solo Atención al Cliente)
            if (!withinOfficeHours && botSettings.awayEnabled && botSettings.awayMessage && departmentName === 'Atención al Cliente') {
                 try {
                     await sock.sendMessage(senderJid, { text: botSettings.awayMessage });
                     console.log(`[WHATSAPP:${channelId}] Mensaje de ausente enviado a ${senderJid} (Atención Cliente).`);
                 } catch (awayMsgError) {
                     console.error(`[WHATSAPP:${channelId}] Error enviando mensaje de ausente:`, awayMsgError);
                 }
            }

            // SOLO asignamos agente si estamos DENTRO del horario laboral
            if (withinOfficeHours) {
                agentToAssign = await findNextAvailableAgent(departmentId);
            } else {
                 console.log(`[WHATSAPP:${channelId}] Chat nuevo de ${pushName} recibido fuera de horario. No se asignará agente.`);
            }

            // Creamos el chat (SIEMPRE, incluso fuera de horario)
            const newChatData = {
                contactName: pushName, contactPhone: senderJid, internalId: `WA-${Date.now().toString().slice(-6)}`,
                departmentIds: [departmentId], platform: 'whatsapp', status: 'Abierto', createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastMessage: lastMessageTextForDb, lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                lastMessageSender: 'contact',
                agentEmail: agentToAssign, // Puede ser null si es fuera de horario
                isBotActive: false,
            };

            // Validación de JID (Sin cambios)
            if (!/^\d{7,15}@s\.whatsapp\.net$/.test(senderJid)) {
                 console.warn(`[WHATSAPP:${channelId}] JID inválido para chat nuevo: ${senderJid}`);
                 return;
            }

			chatDocRef = await chatsRef.add(newChatData);
            chatData = newChatData; // Usamos newChatData para la lógica siguiente

            // Notificamos y enviamos bienvenida SOLO si se asignó un agente (es decir, dentro de horario)
            if (agentToAssign) {
                console.log(`[ASIGNACIÓN] Nuevo chat de ${pushName} (${departmentName}) asignado a ${agentToAssign}`);
                io.emit('new_chat_assigned', { chatId: chatDocRef.id, agentEmail: agentToAssign });

                // Lógica de Mensaje de Bienvenida (Solo Atención al Cliente)
                if (botSettings.welcomeEnabled && botSettings.welcomeMessage && departmentName === 'Atención al Cliente') {
                     try {
                         await sock.sendMessage(senderJid, { text: botSettings.welcomeMessage });
                         console.log(`[WHATSAPP:${channelId}] Mensaje de bienvenida enviado a ${senderJid} (Atención Cliente).`);
                     } catch (welcomeMsgError) {
                         console.error(`[WHATSAPP:${channelId}] Error enviando mensaje de bienvenida:`, welcomeMsgError);
                     }
                }
            }
        // --- FIN LÓGICA CHAT NUEVO ---

        // --- LÓGICA PARA CHAT EXISTENTE (else) ---
        } else {
            chatDocRef = chatQuery.docs[0].ref;
            chatData = chatQuery.docs[0].data();

            // Lógica de Reasignación por Agente Ausente (Sin cambios)
            if (chatData.agentEmail) {
                const agentQuery = await db.collection('agents').where('email', '==', chatData.agentEmail).limit(1).get();
                if (!agentQuery.empty && agentQuery.docs[0].data().status === 'Ausente') {
                    await chatDocRef.update({ agentEmail: null });
                    chatData.agentEmail = null; // Actualizar variable local
                    console.log(`[REASIGNACIÓN] Chat ${chatDocRef.id} desasignado del agente ausente.`);
                }
            }

            // Lógica de Asignación si el chat no tiene agente (Sin cambios)
		    const needsAssignment = !chatData.agentEmail && chatData.status === 'Abierto';
			if (needsAssignment) {
			    const agentToAssign = await findNextAvailableAgent(departmentId);
			    if (agentToAssign) {
				    await chatDocRef.update({ agentEmail: agentToAssign });
				    console.log(`[ASIGNACIÓN] Chat ${chatDocRef.id} respondido por cliente, asignado a ${agentToAssign}`);
				    io.emit('new_chat_assigned', { chatId: chatDocRef.id, agentEmail: agentToAssign });
			    }
		    }

            // Actualizar datos del chat existente (Sin cambios)
            await chatDocRef.update({
                status: 'Abierto', // Reabre el chat si estaba cerrado
                lastMessage: lastMessageTextForDb,
                lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                lastMessageSender: 'contact',
                departmentIds: admin.firestore.FieldValue.arrayUnion(departmentId) // Asegura que el depto esté (aunque ya debería)
            });
        }

        await db.collection('chats').doc(chatDocRef.id).collection('messages').add(messageForDb);

    } 
} 

// --- LÓGICA DE HORARIOS, BOT, ETC. ---
let botSettings = { isEnabled: true, awayMessage: 'Gracias por escribirnos. Nuestro horario de atención ha finalizado por hoy. Te responderemos tan pronto como nuestro equipo esté de vuelta.', schedule: [], welcomeEnabled: false, welcomeMessage: '', closingEnabled: false, closingMessage: '', closingDelay: '10' };
const settingsRef = db.collection('settings').doc('bot');
settingsRef.onSnapshot(doc => { if (doc.exists) { botSettings = { ...botSettings, ...doc.data() }; console.log("[Settings] Configuración del bot actualizada en tiempo real."); } else { console.log("[Settings] No se encontró configuración del bot, usando valores por defecto."); } });

function isWithinOfficeHours() {
    // Si no hay configuración de horarios, o el array está vacío, se asume que siempre está abierto.
    if (!botSettings.schedule || botSettings.schedule.length === 0) {
        return true;
    }

    try {
        const now = new Date();
        const timeZone = 'America/Caracas'; // Zona horaria de Venezuela (UTC-4)

        // Mapeo de días de Intl (en inglés) a los valores de nuestra BD (en español)
        const dayMap = {
            'Monday': 'Lunes',
            'Tuesday': 'Martes',
            'Wednesday': 'Miércoles',
            'Thursday': 'Jueves',
            'Friday': 'Viernes',
            'Saturday': 'Sábado',
            'Sunday': 'Domingo'
        };

        // Obtener el nombre del día de la semana en la zona horaria de Venezuela
        const formatterDay = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' });
        const dayName = formatterDay.format(now); // e.g., "Monday"
        const currentDayName = dayMap[dayName]; // e.g., "Lunes"
        
        // Determinar si es un día de semana para la regla "Lunes a Viernes"
        const isWeekday = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'].includes(currentDayName);

        // Obtener la hora y minuto actual en la zona horaria de Venezuela
        const formatterHour = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false });
        let currentHour = parseInt(formatterHour.format(now)); // 0-23
        
        // Corrección para las 24:00 (que Intl puede devolver como "24" en lugar de "00")
        if (currentHour === 24) currentHour = 0;

        const formatterMinute = new Intl.DateTimeFormat('en-US', { timeZone, minute: '2-digit' });
        const currentMinute = parseInt(formatterMinute.format(now)); // 0-59

        // Convertir la hora actual a un número comparable, ej: 9:30 -> 930
        const currentTime = currentHour * 100 + currentMinute;

        // Iterar sobre las reglas de horario definidas en el panel de admin
        for (const rule of botSettings.schedule) {
            // rule = { day: 'Lunes a Viernes', start: '09:00', end: '17:00' }
            
            let isDayMatch = false;

            if (rule.day === 'Todos los días') {
                isDayMatch = true;
            } else if (rule.day === 'Lunes a Viernes' && isWeekday) {
                isDayMatch = true;
            } else if (currentDayName === rule.day) { // Compara 'Sábado' con 'Sábado' o 'Domingo' con 'Domingo'
                isDayMatch = true;
            }

            if (isDayMatch) {
                // Convertir los tiempos de la regla a números, ej: '09:00' -> 900
                const startTime = parseInt(rule.start.replace(':', ''));
                const endTime = parseInt(rule.end.replace(':', ''));

                // Comprobar si la hora actual está DENTRO del rango
                // El rango es inclusivo en el inicio y exclusivo en el fin (ej: hasta las 17:00 significa 16:59:59)
                if (currentTime >= startTime && currentTime < endTime) {
                    return true; // Se encontró una regla válida. Estamos en horario de oficina.
                }
            }
        }

        // Si el bucle termina sin encontrar una regla, estamos fuera de horario.
        return false;

    } catch (error) {
        console.error("Error al verificar las horas de oficina:", error);
        // En caso de error, asumir que estamos abiertos para no bloquear a los clientes.
        return true;
    }
}


const lastAssignedAgentIndex = {};

async function findNextAvailableAgent(departmentId) {
    if (!departmentId) {
        console.warn("[ASIGNACIÓN] Se intentó asignar un chat sin departmentId.");
        return null;
    }

    try {
        const departmentDoc = await db.collection('departments').doc(departmentId).get();
        if (!departmentDoc.exists) {
            console.error(`[ASIGNACIÓN] No se encontró el departamento con ID: ${departmentId}`);
            return null;
        }
        const departmentName = departmentDoc.data().name;

        const agentsRef = db.collection('agents');
        const snapshot = await agentsRef
            .where('department', '==', departmentName)
            .where('status', '==', 'Disponible')
            .get();

        if (snapshot.empty) {
            console.log(`[ASIGNACIÓN] No se encontraron agentes disponibles para el departamento ${departmentName}.`);
            return null;
        }

        const availableAgents = snapshot.docs.map(doc => doc.data());
        
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

    socket.on('conectar_canal', ({ channelId }) => connectToWhatsApp(channelId, false));
    socket.on('desconectar_canal', ({ channelId }) => disconnectWhatsApp(channelId));

    socket.on('link_channel_to_department', async ({ channelId, departmentId }) => {
        try {
            await db.collection('channels').doc(channelId).update({ departmentId });
        } catch (error) { console.error("Error al vincular canal:", error); }
    });

    socket.on('get_all_channel_statuses', async () => {
        await checkTelegramHealth();
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
                lastMessage: lastMessageText, 
                lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                lastMessageSender: 'agent'
            });
        } catch (error) {
            console.error(`Error al enviar mensaje al chat ${chatId}:`, error);
            socket.emit('envio_fallido', { chatId, error: 'Error interno del servidor.' });
        }
    });

    socket.on('iniciar_nuevo_chat', async (data) => {
    const { recipientNumber, name, channelId, initialMessage, agentEmail, departmentId } = data;
    console.log(`[OUTBOUND] Solicitud para iniciar chat/crear contacto con ${recipientNumber}`);

    if (!recipientNumber || !name || !departmentId) {
        return socket.emit('envio_fallido', { error: "Faltan datos (nombre, teléfono, departamento) para crear el contacto." });
    }
    const formattedNumber = `${recipientNumber.replace(/\D/g, '')}@s.whatsapp.net`;
    if (!/^\d{10,15}@s\.whatsapp\.net$/.test(formattedNumber)) {
        return socket.emit('envio_fallido', { error: "El número de teléfono no es válido." });
    }

    try {
        const chatsRef = db.collection('chats');
        
        // ---
        // --- ¡AQUÍ ESTÁ EL CAMBIO! ---
        // ---
        // Se añade .where('departmentIds', 'array-contains', departmentId)
        // para buscar solo en el departamento que estás seleccionando.
        let chatQuery = await chatsRef
            .where('contactPhone', '==', formattedNumber)
            .where('departmentIds', 'array-contains', departmentId)
            .limit(1).get();
        // ---
        // --- ¡FIN DEL CAMBIO! ---
        // ---

        let chatId;

        if (chatQuery.empty) {
            console.log(`[OUTBOUND] Creando nuevo chat/contacto para ${formattedNumber} en el depto ${departmentId}`);
            const newChatData = {
                contactName: name,
                contactPhone: formattedNumber,
                internalId: `WA-${Date.now().toString().slice(-6)}`,
                departmentIds: [departmentId],
                platform: 'whatsapp',
                status: initialMessage && channelId ? 'Abierto' : 'Cerrado', // Si no hay mensaje, se crea como cerrado
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastMessage: initialMessage || 'Contacto creado.',
                lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                lastMessageSender: initialMessage && channelId ? 'agent' : null,
                agentEmail: agentEmail,
                isBotActive: false,
            };
            const chatDocRef = await chatsRef.add(newChatData);
            chatId = chatDocRef.id;
        } else {
            console.log(`[OUTBOUND] El chat con ${formattedNumber} ya existe en este depto. Actualizando...`);
            chatId = chatQuery.docs[0].id;
            await chatQuery.docs[0].ref.update({
                status: 'Abierto',
                agentEmail: agentEmail,
                lastMessage: initialMessage || 'Chat actualizado.',
                lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                lastMessageSender: initialMessage && channelId ? 'agent' : null,
            });
        }

        if (channelId && initialMessage) {
            const client = whatsappClients[channelId];
            if (!client) {
                console.warn(`[OUTBOUND] El contacto ${chatId} fue creado/actualizado, pero no se envió mensaje porque el canal ${channelId} no está conectado.`);
                socket.emit('nuevo_chat_iniciado', { chatId: chatId, message: 'Contacto creado, pero el canal no está conectado para enviar el mensaje.' });
                return;
            }

            const sentMessage = await client.sendMessage(formattedNumber, { text: initialMessage });

            await db.collection('chats').doc(chatId).collection('messages').add({
                text: initialMessage,
                sender: 'agent',
                agentEmail: agentEmail,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                status: 'sent'
            });

            if (sentMessage) {
                crmSentMessageIds.add(sentMessage.key.id);
            }

            console.log(`[OUTBOUND] Mensaje inicial enviado a ${formattedNumber}`);
        } else {
            console.log(`[OUTBOUND] Contacto ${chatId} creado/actualizado sin enviar mensaje inicial.`);
        }

        socket.emit('nuevo_chat_iniciado', { chatId: chatId });

    } catch (error) {
        console.error(`[OUTBOUND] Error crítico al iniciar nuevo chat:`, error);
        socket.emit('envio_fallido', { error: `Error del servidor: ${error.message}` });
    }
});

    
// Archivo: server.js -> Reemplaza este listener completo

    socket.on('solicitar_calificacion', async ({ chatId }) => {
        // 1. Verificar si la función está habilitada en la configuración
        if (!botSettings.closingEnabled || !botSettings.closingMessage) {
            console.log(`[CALIFICACIÓN] Función de cierre deshabilitada. No se enviará mensaje para el chat ${chatId}.`);
            return; // No hacer nada si está deshabilitado
        }
    
        try {
            // 2. Obtener los datos del chat Y el nombre del departamento
            const chatDoc = await db.collection('chats').doc(chatId).get();
            if (!chatDoc.exists) {
                console.warn(`[CALIFICACIÓN] El chat ${chatId} no existe.`);
                return;
            }
            const chatData = chatDoc.data();

            
            let departmentName = null;
            if (chatData.departmentIds && chatData.departmentIds.length > 0) {
               
                 const atencionClienteId = 'atencion-al-cliente'; 
                 const deptIdToCheck = chatData.departmentIds.includes(atencionClienteId)
                                    ? atencionClienteId
                                    : chatData.departmentIds[0]; // Si no lo incluye, usa el primero como fallback (aunque la lógica ahora debería detenerse)
                 
                 const deptDoc = await db.collection('departments').doc(deptIdToCheck).get();
                 if (deptDoc.exists) {
                     departmentName = deptDoc.data().name;
                 } else {
                     console.warn(`[CALIFICACIÓN] No se encontró el documento del departamento con ID ${deptIdToCheck} para el chat ${chatId}.`);
                 }
            } else {
                console.warn(`[CALIFICACIÓN] El chat ${chatId} no tiene departmentIds definidos.`);
            }

            // Si no es del departamento de Atención al Cliente, no enviamos mensaje de cierre/calificación
            if (departmentName !== 'Atención al Cliente') {
                 console.log(`[CALIFICACIÓN] El chat ${chatId} (${departmentName || 'Sin Depto'}) no pertenece a Atención al Cliente. No se enviará mensaje de cierre.`);
                 return; // Salimos de la función
            }
            // --- FIN DE LA MODIFICACIÓN ---

            const recipientId = chatData.contactPhone || chatData.contactId; // JID/ID del cliente
            let client;
            let platform = chatData.platform;
    
            if (platform === 'whatsapp') {
                const channel = await findChannelForChat(chatData); // Usamos la función que ya existe
                client = channel && whatsappClients[channel.id];
            } else if (platform === 'telegram') {
                client = bot; // Usamos el bot de Telegraf
            }
    
            if (!client) {
                console.warn(`[CALIFICACIÓN] No se encontró cliente conectado (${platform}) para el chat ${chatId}`);
                return;
            }
            
            // 4. Implementar el retraso (delay)
            const delayInMinutes = parseInt(botSettings.closingDelay, 10) || 1; // 1 minuto por defecto si el valor es inválido
            const delayInMs = delayInMinutes * 60 * 1000;
            
            console.log(`[CALIFICACIÓN] Programando mensaje de cierre para el chat ${chatId} (${departmentName}) en ${delayInMinutes} min.`);
    
            setTimeout(async () => {
                try {
                    // Doble chequeo: el chat sigue existiendo y está cerrado?
                    const freshChatDoc = await db.collection('chats').doc(chatId).get();
                    if (!freshChatDoc.exists || freshChatDoc.data().status !== 'Cerrado') {
                        console.log(`[CALIFICACIÓN] Cancelando mensaje de cierre para ${chatId} (chat reabierto o no existe).`);
                        return;
                    }
    
                    // 5. Enviar el mensaje de cierre
                    let sentMessage;
                    if (platform === 'whatsapp') {
                        sentMessage = await client.sendMessage(recipientId, { text: botSettings.closingMessage });
                    } else if (platform === 'telegram') {
                        // Telegraf (por ahora, solo enviamos. La captura de reacción es solo para WhatsApp)
                        await client.telegram.sendMessage(recipientId, botSettings.closingMessage);
                    }
                    
                    // 6. Guardar el ID del mensaje de calificación (solo para WhatsApp)
                    if (platform === 'whatsapp' && sentMessage) {
                        await db.collection('chats').doc(chatId).update({
                            ratingMessageId: sentMessage.key.id // Guardamos el ID del mensaje que espera reacción
                        });
                    }
                    
                    console.log(`[CALIFICACIÓN] Mensaje de cierre enviado al chat ${chatId}`);
    
                } catch (error) {
                    console.error(`[CALIFICACIÓN] Error al enviar mensaje de cierre (timeout) al chat ${chatId}:`, error);
                }
            }, delayInMs);
    
        } catch (error) {
            console.error(`[CALIFICACIÓN] Error general en 'solicitar_calificacion' para el chat ${chatId}:`, error);
        }
    });
	
	// Archivo: server.js -> Reemplaza este listener completo

    socket.on('guardar_nota_interna', async (data) => {
        const { chatId, agentEmail, noteText } = data;

        if (!chatId || !agentEmail || !noteText || !noteText.trim()) {
            console.warn(`[NOTA INTERNA] Datos inválidos recibidos para guardar nota.`);
            socket.emit('nota_interna_error', { chatId, error: 'Datos incompletos.' });
            return;
        }

        try {
            // --- Extracción de Menciones (Sin cambios) ---
            const mentionRegex = /@([\w\s-]+)/g;
            const mentionedNames = [];
            let match;
            while ((match = mentionRegex.exec(noteText)) !== null) {
                mentionedNames.push(match[1].trim());
            }

            let mentionedEmails = [];
            if (mentionedNames.length > 0) {
                const agentsSnapshot = await db.collection('agents').get();
                const agentsData = agentsSnapshot.docs.map(doc => doc.data());
                mentionedEmails = mentionedNames
                    .map(name => {
                        const foundAgent = agentsData.find(agent => agent.name === name);
                        return foundAgent ? foundAgent.email : null;
                    })
                    .filter(email => email !== null && email !== agentEmail); // Filtra nulos y auto-menciones
            }
            // --- Fin Extracción de Menciones ---


            // Referencia a la subcolección de notas internas
            const notesRef = db.collection('chats').doc(chatId).collection('internal_notes');

            // Añadimos la nueva nota con el campo 'mentions'
            const newNoteData = {
                text: noteText.trim(),
                agentEmail: agentEmail,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                readBy: [agentEmail], // El autor la marca como leída automáticamente
                mentions: mentionedEmails // Array de emails mencionados
            };

            const noteDocRef = await notesRef.add(newNoteData); // Guardamos la referencia para obtener el ID si es necesario

            console.log(`[NOTA INTERNA] Nota guardada (${noteDocRef.id}) para chat ${chatId} por ${agentEmail}. Menciones: ${mentionedEmails.join(', ')}`);
            socket.emit('nota_interna_guardada', { chatId }); // Confirmación

            // --- INICIO: Lógica para Crear Notificaciones ---
            if (mentionedEmails.length > 0) {
                console.log(`[NOTIFICACIÓN] Creando notificaciones para: ${mentionedEmails.join(', ')} sobre nota en chat ${chatId}`);

                // Obtenemos el nombre del contacto para el texto de la notificación (opcional pero útil)
                let contactName = 'un chat';
                try {
                    const chatDoc = await db.collection('chats').doc(chatId).get();
                    if (chatDoc.exists) {
                        contactName = chatDoc.data().contactName || contactName;
                    }
                } catch (err) {
                    console.warn(`[NOTIFICACIÓN] No se pudo obtener el nombre del contacto para el chat ${chatId}`);
                }

                // Usamos un batch write para crear todas las notificaciones eficientemente
                const batch = db.batch();
                const notificationsRef = db.collection('notifications'); // Colección principal para notificaciones

                mentionedEmails.forEach(recipientEmail => {
                    const notificationDocRef = notificationsRef.doc(); // Firestore genera un ID automático
                    batch.set(notificationDocRef, {
                        recipientEmail: recipientEmail, // Quién recibe la notificación
                        senderEmail: agentEmail,        // Quién envió la nota
                        chatId: chatId,                 // En qué chat ocurrió
                        chatContactName: contactName,   // Nombre del cliente
                        noteId: noteDocRef.id,          // ID de la nota interna específica
                        type: 'mention',                // Tipo de notificación
                        text: `te mencionó en una nota interna en el chat de ${contactName}.`, // Texto a mostrar
                        timestamp: admin.firestore.FieldValue.serverTimestamp(), // Hora de creación
                        read: false                     // Estado inicial: no leída
                    });
                });

                // Ejecutamos el batch
                await batch.commit();
                console.log(`[NOTIFICACIÓN] ${mentionedEmails.length} notificaciones creadas.`);
            }
            // --- FIN: Lógica para Crear Notificaciones ---

        } catch (error) {
            console.error(`[NOTA INTERNA] Error al guardar nota y/o crear notificaciones para chat ${chatId}:`, error);
            socket.emit('nota_interna_error', { chatId, error: 'Error del servidor al guardar la nota.' });
        }
    });

	socket.on('marcar_notas_leidas', async (data) => {
        const { chatId, agentEmail, noteIds } = data;

        if (!chatId || !agentEmail || !Array.isArray(noteIds) || noteIds.length === 0) {
            console.warn(`[NOTA INTERNA LEÍDA] Datos inválidos recibidos para marcar notas.`);
            return;
        }

        try {
            // Referencia a la subcolección
            const notesRef = db.collection('chats').doc(chatId).collection('internal_notes');
            
            // Usamos un batch write para actualizar múltiples documentos eficientemente
            const batch = db.batch();

            noteIds.forEach(noteId => {
                const noteDocRef = notesRef.doc(noteId);
                // Usamos arrayUnion para añadir el email al array 'readBy'
                // Si el email ya existe, arrayUnion no hace nada (idempotente)
                batch.update(noteDocRef, {
                    readBy: admin.firestore.FieldValue.arrayUnion(agentEmail)
                });
            });

            // Ejecutamos el batch
            await batch.commit();
            console.log(`[NOTA INTERNA LEÍDA] ${noteIds.length} notas marcadas como leídas por ${agentEmail} en chat ${chatId}.`);

        } catch (error) {
            console.error(`[NOTA INTERNA LEÍDA] Error al marcar notas como leídas para chat ${chatId}:`, error);
            // Podríamos emitir un error al cliente si es crítico
            // socket.emit('marcar_leidas_error', { chatId, error: 'Error del servidor.' });
        }
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
