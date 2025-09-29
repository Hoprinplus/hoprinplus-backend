// --- server.js ---

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

const whatsappClients = {};
const qrCodes = {};
const qrTimeouts = {};

// --- LÓGICA DE HORARIOS DE OFICINA Y MENSAJES AUTOMÁTICOS ---
let botSettings = { isEnabled: true, awayMessage: 'Gracias por escribirnos. Nuestro horario de atención ha finalizado por hoy. Te responderemos tan pronto como nuestro equipo esté de vuelta.', schedule: [], welcomeEnabled: false, welcomeMessage: '', closingEnabled: false, closingMessage: '', closingDelay: '10' };

const settingsRef = db.collection('settings').doc('bot');
settingsRef.onSnapshot(doc => {
    if (doc.exists) {
        botSettings = { ...botSettings, ...doc.data() };
        console.log("[Settings] Configuración del bot actualizada en tiempo real.");
    } else {
        console.log("[Settings] No se encontró configuración del bot, usando valores por defecto.");
    }
});

// --- LÓGICA DEL BOT BUILDER (FASE 2) ---
let activeBotFlow = {
    nodes: [
        { id: 'start', type: 'start', content: 'Inicio del Flujo' },
        { id: 'welcome', type: 'sendMessage', content: 'Hola, soy Hoprin-Bot, el asistente virtual de Hoprin+. Para agilizar tu solicitud, por favor, indícame con qué área deseas comunicarte:' },
        { id: 'ask_department', type: 'askQuestion', content: '*1.* Ventas\n*2.* Soporte', options: [
            { text: '1', nextNodeId: 'transfer_sales' },
            { text: '2', nextNodeId: 'transfer_support' }
        ]},
        { id: 'transfer_sales', type: 'transferToAgent', content: '¡Perfecto! Un agente del área de Ventas te atenderá en breve.', tags: [{ name: 'Ventas', color: 'blue' }] },
        { id: 'transfer_support', type: 'transferToAgent', content: '¡Entendido! Un agente del área de Soporte te atenderá en breve.', tags: [{ name: 'Soporte', color: 'yellow' }] }
    ],
    edges: [
        { source: 'start', target: 'welcome' },
        { source: 'welcome', target: 'ask_department' }
    ]
};

const botFlowRef = db.collection('bot_flows').doc('default_welcome');
botFlowRef.onSnapshot(doc => {
    if (doc.exists) {
        activeBotFlow = doc.data();
        console.log("[Bot Flow] Flujo del bot actualizado desde Firestore.");
    } else {
        console.log("[Bot Flow] No se encontró flujo en Firestore, usando el flujo por defecto codificado.");
    }
});

async function executeNode(node, sock, senderJid, chatDocRef) {
    if (!node) return;

    switch (node.type) {
        case 'sendMessage':
            await sock.sendMessage(senderJid, { text: node.content });
            const nextEdge = activeBotFlow.edges.find(edge => edge.source === node.id);
            if (nextEdge) {
                const nextNode = activeBotFlow.nodes.find(n => n.id === nextEdge.target);
                await executeNode(nextNode, sock, senderJid, chatDocRef);
            }
            break;
        case 'askQuestion':
            await sock.sendMessage(senderJid, { text: node.content });
            await chatDocRef.update({ botState: { flowId: 'default_welcome', currentNodeId: node.id } });
            break;
        case 'transferToAgent':
            await sock.sendMessage(senderJid, { text: node.content });
            if (node.tags && node.tags.length > 0) {
                 await chatDocRef.update({ tags: admin.firestore.FieldValue.arrayUnion(...node.tags) });
            }
            const chatData = (await chatDocRef.get()).data();
            const agentToAssign = await findNextAvailableAgent(chatData.departmentId);
            await chatDocRef.update({ isBotActive: false, agentEmail: agentToAssign });
            if (agentToAssign) {
                io.emit('new_chat_assigned', { chatId: chatDocRef.id, agentEmail: agentToAssign });
            }
            break;
    }
}

async function processBotMessage(chatDocRef, chatData, messageText, sock) {
    const currentState = chatData.botState;
    if (!currentState || !currentState.currentNodeId) return;

    const currentNode = activeBotFlow.nodes.find(n => n.id === currentState.currentNodeId);
    if (!currentNode || currentNode.type !== 'askQuestion') return;

    const matchedOption = currentNode.options.find(opt => opt.text.toLowerCase() === messageText.toLowerCase());

    if (matchedOption) {
        const nextNode = activeBotFlow.nodes.find(n => n.id === matchedOption.nextNodeId);
        await executeNode(nextNode, sock, chatData.contactPhone, chatDocRef);
    } else {
        // Opcional: enviar mensaje de opción inválida
        await sock.sendMessage(chatData.contactPhone, { text: 'Opción no válida. Por favor, elige una de las opciones listadas.' });
    }
}


function isWithinOfficeHours() {
    if (!botSettings.awayEnabled || !botSettings.schedule || botSettings.schedule.length === 0) {
        return true; 
    }
    const now = new Date();
    const timeZone = 'America/Caracas';
    const currentTimeStr = now.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }); 
    const dayOfWeek = now.getDay(); 

    for (const s of botSettings.schedule) {
        let isDayMatch = false;
        switch (s.day) {
            case 'Lunes a Viernes':
                if (dayOfWeek >= 1 && dayOfWeek <= 5) isDayMatch = true;
                break;
            case 'Sábado':
                if (dayOfWeek === 6) isDayMatch = true;
                break;
            case 'Domingo':
                if (dayOfWeek === 0) isDayMatch = true;
                break;
            case 'Todos los días':
                isDayMatch = true;
                break;
        }
        if (isDayMatch && currentTimeStr >= s.start && currentTimeStr < s.end) {
            return true;
        }
    }
    return false;
}


async function findNextAvailableAgent(departmentId) {
    try {
        const openChatsSnapshot = await db.collection('chats').where('status', '==', 'Abierto').get();
        const agentChatCounts = {};
        openChatsSnapshot.forEach(doc => {
            const agentEmail = doc.data().agentEmail;
            if (agentEmail) {
                agentChatCounts[agentEmail] = (agentChatCounts[agentEmail] || 0) + 1;
            }
        });

        const agentsQuery = await db.collection('agents')
            .where('department', '==', departmentId)
            .where('status', '==', 'Disponible')
            .where('role', 'in', ['agente', 'supervisor'])
            .get();

        if (agentsQuery.empty) {
            console.log(`[Asignación] No se encontraron agentes disponibles en el departamento ${departmentId}.`);
            return null;
        }

        const availableAgents = agentsQuery.docs.map(doc => ({
            email: doc.data().email,
            openChats: agentChatCounts[doc.data().email] || 0
        }));

        availableAgents.sort((a, b) => a.openChats - b.openChats);
        
        const agentToAssign = availableAgents[0];
        console.log(`[Asignación] Agente seleccionado: ${agentToAssign.email} con ${agentToAssign.openChats} chats abiertos.`);
        return agentToAssign.email;

    } catch (error) {
        console.error("[Asignación] Error al buscar agente disponible:", error);
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
        const fileRef = ref(storage.bucket(), fileName);

        await uploadBytes(fileRef, req.file.buffer, { contentType: req.file.mimetype });
        const downloadURL = await getDownloadURL(fileRef);

        res.status(200).json({ url: downloadURL, mimetype: req.file.mimetype, name: req.file.originalname });
    } catch (error) {
        console.error("Error al subir archivo:", error);
        res.status(500).send("Error al subir el archivo.");
    }
});

async function connectToWhatsApp(channelId, departmentId, isAutoReconnect = false) {
    console.log(`[WHATSAPP:${channelId}] Iniciando conexión...`);
    const authDir = `baileys_auth_${channelId}`;
    try {
        await fs.access(`${authDir}/creds.json`);
    } catch {
        console.log(`[WHATSAPP:${channelId}] Credenciales no encontradas. Limpiando posible sesión corrupta...`);
        await fs.rm(authDir, { recursive: true, force: true }).catch(()=>{});
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: state,
        browser: [`Hoprin+ (${channelId})`, 'Chrome', '1.0.0'],
        logger: pino({ level: 'silent' }),
        ws: NodeWebSocket,
    });

    whatsappClients[channelId] = { sock, departmentId };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if(update.isNewLogin) console.log(`[WHATSAPP:${channelId}] ¡Nuevo login detectado y exitoso!`);
        if(update.isOnline === true) console.log(`[WHATSAPP:${channelId}] Cliente está online.`);

        if (qr) {
            if (isAutoReconnect) {
                console.log(`[WHATSAPP:${channelId}] Sesión inválida en reconexión. Abortando.`);
                if(sock?.end) sock.end(new Error("Invalid session"));
                return;
            }
            console.log(`[WHATSAPP:${channelId}] QR recibido, enviando al frontend...`);
            qrCodes[channelId] = await qrcode.toDataURL(qr);
            io.emit('qr_update', { channelId, qrCodeUrl: qrCodes[channelId] });

            if (qrTimeouts[channelId]) clearTimeout(qrTimeouts[channelId]);
            qrTimeouts[channelId] = setTimeout(() => {
                if (qrCodes[channelId]) {
                    console.log(`[WHATSAPP:${channelId}] El QR ha expirado (60s).`);
                    if(sock?.end) sock.end(new Error("QR Timeout"));
                }
            }, 60000);
        }

        if (connection === 'open') {
            console.log(`[WHATSAPP:${channelId}] ¡Conexión abierta!`);
            if (qrTimeouts[channelId]) clearTimeout(qrTimeouts[channelId]);
            delete qrCodes[channelId];
            io.emit('status_update', { channelId, status: 'Conectado' });
            io.emit('qr_update', { channelId, qrCodeUrl: null });
        } else if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
            console.error(`[WHATSAPP:${channelId}] Conexión cerrada. Razón completa:`, lastDisconnect.error);

            delete whatsappClients[channelId];
            io.emit('status_update', { channelId, status: 'Desconectado' });

            if (lastDisconnect.error?.message === "QR Timeout") {
                return;
            }

            if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.restartRequired || statusCode === 401) {
                console.log(`[WHATSAPP:${channelId}] Cierre de sesión forzado (Razón: ${statusCode}). Limpiando sesión automáticamente...`);
                await fs.rm(authDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        const currentClient = whatsappClients[channelId];
        if (!msg.message || !currentClient || !currentClient.departmentId) return;

        const messageType = Object.keys(msg.message)[0];
        const messageContent = msg.message[messageType];
        
        const messageText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const senderJid = msg.key.remoteJid;

        if (msg.key.fromMe) {
             const chatQuery = await db.collection('chats').where('contactPhone', '==', senderJid).limit(1).get();
             if (!chatQuery.empty) {
                 const chatDoc = chatQuery.docs[0];
                 await db.collection('chats').doc(chatDoc.id).collection('messages').add({ text: messageText, sender: 'agent', senderEmail: 'sync_phone', timestamp: admin.firestore.FieldValue.serverTimestamp(), status: 'read' });
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
                    for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
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
            }
            
            if (chatQuery.empty) {
                if (!botSettings.isEnabled) return;
                if (!isWithinOfficeHours()) {
                    if (botSettings.awayEnabled && botSettings.awayMessage) { await sock.sendMessage(senderJid, { text: botSettings.awayMessage }); }
                    return;
                }
                
                const agentToAssign = await findNextAvailableAgent(currentClient.departmentId);
                const newChatData = {
                    contactName: pushName, contactPhone: senderJid, internalId: `WA-${Date.now().toString().slice(-6)}`,
                    departmentId: currentClient.departmentId, status: 'Abierto', createdAt: admin.firestore.FieldValue.serverTimestamp(),
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
                await chatDocRef.update({ status: 'Abierto', lastMessage: lastMessageTextForDb, lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp() });
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
    });

    sock.ev.on('messages.update', async (updates) => {
        for(const { key, update } of updates) {
            if(update.status) {
                try {
                    const messagesRef = db.collectionGroup('messages').where('whatsappMessageId', '==', key.id);
                    const msgSnapshot = await messagesRef.get();
                    if (!msgSnapshot.empty) {
                        const msgDoc = msgSnapshot.docs[0];
                        let newStatus = msgDoc.data().status;
                        if (newStatus === 'read') continue;
                        switch(update.status) {
                            case proto.WebMessageInfo.WebMessageInfoStatus.DELIVERY_ACK: newStatus = 'delivered'; break;
                            case proto.WebMessageInfo.WebMessageInfoStatus.READ: newStatus = 'read'; break;
                        }
                        await msgDoc.ref.update({ status: newStatus });
                    }
                } catch(e) { console.error("Error al actualizar estado de mensaje:", e.message); }
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

let channels = [];
db.collection('channels').onSnapshot(snapshot => {
    channels = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
});

io.on('connection', (socket) => {
    console.log(`Un usuario frontend se ha conectado: ${socket.id}`);
    Object.entries(qrCodes).forEach(([channelId, qrCodeUrl]) => socket.emit('qr_update', { channelId, qrCodeUrl }));
    Object.keys(whatsappClients).forEach(channelId => socket.emit('status_update', { channelId, status: 'Conectado' }));

    socket.on('conectar_canal', ({ channelId }) => {
        const departmentId = channels.find(c => c.id === channelId)?.departmentId || null;
        connectToWhatsApp(channelId, departmentId, false);
    });

    socket.on('link_channel_to_department', async ({ channelId, departmentId }) => {
        try {
            const channelRef = db.collection('channels').doc(channelId);
            await channelRef.update({ departmentId });
            if (whatsappClients[channelId]) whatsappClients[channelId].departmentId = departmentId;
        } catch (error) { console.error("Error al vincular canal:", error); }
    });

    socket.on('desconectar_canal', async ({ channelId }) => {
        const authDir = `baileys_auth_${channelId}`;
        if (whatsappClients[channelId]) await whatsappClients[channelId].sock.logout();
        await fs.rm(authDir, { recursive: true, force: true }).catch(() => {});
        delete whatsappClients[channelId];
        io.emit('status_update', { channelId, status: 'Desconectado' });
    });

    socket.on('enviar_mensaje', async ({ chatId, message, agentEmail, fileUrl, fileType, fileName }) => {
        try {
            const chatRef = db.collection('chats').doc(chatId);
            const chatDoc = await chatRef.get();
            if (!chatDoc.exists) throw new Error(`Chat ${chatId} no existe.`);

            const { contactPhone, departmentId } = chatDoc.data();
            const client = Object.values(whatsappClients).find(c => c.departmentId === departmentId);
            if (!client) throw new Error(`No hay canal conectado para el departamento ${departmentId}`);

            let sentMsg;
            let messageData;
            let lastMessageText = message;

            if (fileUrl) {
                const messageOptions = { caption: message || '' };
                if (fileType.startsWith('image/')) {
                    messageOptions.image = { url: fileUrl };
                    lastMessageText = message || '📷 Imagen';
                } else {
                    messageOptions.document = { url: fileUrl };
                    messageOptions.mimetype = fileType;
                    messageOptions.fileName = fileName || 'Documento';
                    lastMessageText = fileName;
                }
                sentMsg = await client.sock.sendMessage(contactPhone, messageOptions);
                messageData = { text: message, fileUrl, fileType, fileName, sender: 'agent', senderEmail: agentEmail, timestamp: admin.firestore.FieldValue.serverTimestamp(), status: 'sent', whatsappMessageId: sentMsg.key.id };
            } else {
                sentMsg = await client.sock.sendMessage(contactPhone, { text: message });
                messageData = { text: message, sender: 'agent', senderEmail: agentEmail, timestamp: admin.firestore.FieldValue.serverTimestamp(), status: 'sent', whatsappMessageId: sentMsg.key.id };
            }

            await chatRef.collection('messages').add(messageData);
            await chatRef.update({ lastMessage: lastMessageText, lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(), agentEmail, isBotActive: false });

        } catch (err) {
            console.error('Error al enviar mensaje:', err.message);
            socket.emit('envio_fallido', { chatId: chatId, error: err.message });
        }
    });

    socket.on('solicitar_calificacion', async ({ chatId }) => {
        try {
            const chatRef = db.collection('chats').doc(chatId);
            const chatDoc = await chatRef.get();
            if (!chatDoc.exists) return;
            
            await chatRef.update({ status: 'Cerrado', ratingPending: true, closedAt: admin.firestore.FieldValue.serverTimestamp() });

            const { contactPhone, departmentId } = chatDoc.data();
            const client = Object.values(whatsappClients).find(c => c.departmentId === departmentId);
            if (client && client.sock.user) {
                if (botSettings.closingEnabled && botSettings.closingMessage) {
                    const delayInMs = parseInt(botSettings.closingDelay, 10) * 60 * 1000;
                    setTimeout(async () => {
                        try {
                            await client.sock.sendMessage(contactPhone, { text: botSettings.closingMessage });
                        } catch (e) { console.error(`[${chatId}] Error al enviar msg de cierre personalizado:`, e); }
                    }, delayInMs);
                } else {
                    setTimeout(async () => {
                        try {
                            const ratingMessage = "Gracias por contactar a Hoprin+. Por favor, califica tu experiencia del 1 al 5 respondiendo solo con el número.";
                            await client.sock.sendMessage(contactPhone, { text: ratingMessage });
                        } catch (e) { console.error(`[${chatId}] Error al enviar msg de calificación (fallback):`, e); }
                    }, 3000);
                }
            }
        } catch (error) { console.error(`Error en proceso de calificación para ${chatId}:`, error); }
    });

    socket.on('disconnect', () => console.log(`Usuario frontend desconectado: ${socket.id}`));
});

async function reconnectChannelsOnStartup() {
    console.log("Buscando sesiones guardadas para reconectar...");
    try {
        const allFiles = await fs.readdir(__dirname);
        const sessionDirs = allFiles.filter(file => file.startsWith('baileys_auth_'));
        for (const dir of sessionDirs) {
            const channelId = dir.replace('baileys_auth_', '');
            const channelDoc = await db.collection('channels').doc(channelId).get();
            if (channelDoc.exists) {
                console.log(`Se encontró sesión para ${channelId}. Reconectando...`);
                connectToWhatsApp(channelId, channelDoc.data().departmentId, true);
            }
        }
    } catch (error) {
        console.error("Error al reconectar canales:", error);
    }
}


// --- INICIO: Bloque de código para API de KPIs del ERP ---
// Clave de API secreta para proteger los endpoints. ¡Debe ser diferente a la de Laravel!
const ERP_API_KEY = 'tu-clave-secreta-para-el-crm-aqui'; // <-- ¡CAMBIA ESTO!
// Middleware de seguridad para verificar la clave de API
const verifyApiKey = (req, res, next) => {
    const apiKey = req.header('X-API-KEY');
    if (apiKey === ERP_API_KEY) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};
// Endpoint para obtener la calificación promedio de los chats
app.get('/api/kpis/calificacion-promedio', verifyApiKey, async (req, res) => {
    try {
        const chatsRef = db.collection('chats');
        // Buscamos chats cerrados que tengan una calificación (rating)
        const snapshot = await chatsRef.where('status', '==', 'Cerrado').where('rating', '>', 0).get();
        if (snapshot.empty) {
            return res.json({ metric: 'calificacion', data: { current: 0, previous: 0 } });
        }
        let totalRating = 0;
        snapshot.forEach(doc => {
            totalRating += doc.data().rating;
        });
        const averageRating = (totalRating / snapshot.size) * 20; // Convertir de escala 1-5 a 0-100
        // Simulación del dato previo
        const previousAverage = Math.max(0, averageRating - 5);
        res.json({
            metric: 'calificacion',
            data: {
                current: averageRating.toFixed(0),
                previous: previousAverage.toFixed(0)
            }
        });
    } catch (error) {
        console.error("Error en /api/kpis/calificacion-promedio:", error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
// Endpoint para obtener los reportes de soporte activos (chats abiertos)
app.get('/api/kpis/reportes-activos', verifyApiKey, async (req, res) => {
    try {
        const chatsRef = db.collection('chats');
        const snapshot = await chatsRef.where('status', '==', 'Abierto').get();
        // Simulación del dato previo
        const previousCount = Math.max(0, snapshot.size - 2);
        res.json({
            metric: 'reportes_activos',
            data: {
                current: snapshot.size,
                previous: previousCount,
            }
        });
    } catch (error) {
        console.error("Error en /api/kpis/reportes-activos:", error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
// --- FIN: Bloque de código para API de KPIs del ERP ---


server.listen(PORT, () => {
    console.log(`Servidor iniciado en puerto ${PORT}`);
    reconnectChannelsOnStartup();
});

