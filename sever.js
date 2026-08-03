import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Configurazione CORS per consentire connessioni dal client
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));

// --- Database JSON Locale con Persistenza ---
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initialDb = { users: [], messages: [], calls: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2));
    return initialDb;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch (err) {
    return { users: [], messages: [], calls: [] };
  }
}

function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Generatore di codice univoco a 10 cifre
function generate10DigitCode(existingUsers) {
  let attempts = 0;
  while (attempts < 1000) {
    const code = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    const exists = existingUsers.some(u => u.alternativeId === code || u.phoneNumber === code);
    if (!exists) return code;
    attempts++;
  }
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

// Helper calcolo età
function calculateAge(dobString) {
  const dob = new Date(dobString);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }
  return age;
}

// --- REST API ENDPOINTS ---

// 1. Registrazione Utente
app.post("/api/register", (req, res) => {
  const { firstName, lastName, dob, password, phoneNumber } = req.body;

  if (!firstName || !lastName || !dob || !password) {
    return res.status(400).json({ error: "Tutti i campi obbligatori devono essere compilati." });
  }

  const age = calculateAge(dob);
  if (age < 18) {
    return res.status(400).json({ error: "Devi avere almeno 18 anni per registrarti." });
  }

  const db = readDb();
  const code10 = generate10DigitCode(db.users);

  const newUser = {
    id: `user_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    firstName,
    lastName,
    dob,
    age,
    phoneNumber: phoneNumber || null,
    alternativeId: code10,
    password, // In produzione consiglito hash bcrypt
    createdAt: new Date().toISOString(),
    lastLogin: new Date().toISOString(),
    consentAccepted: true
  };

  db.users.push(newUser);
  writeDb(db);

  const { password: _, ...safeUser } = newUser;
  res.json({ success: true, user: safeUser });
});

// 2. Login Utente tramite Codice a 10 Cifre o Telefono
app.post("/api/login", (req, res) => {
  const { identifier, password } = req.body;
  const db = readDb();

  const user = db.users.find(
    u => (u.alternativeId === identifier || u.phoneNumber === identifier || u.id === identifier) && u.password === password
  );

  if (!user) {
    return res.status(401).json({ error: "Codice ID o Password non corretti." });
  }

  user.lastLogin = new Date().toISOString();
  writeDb(db);

  const { password: _, ...safeUser } = user;
  res.json({ success: true, user: safeUser });
});

// 3. Ricerca Utenti tramite Codice a 10 Cifre
app.get("/api/users/:code", (req, res) => {
  const { code } = req.params;
  const db = readDb();

  const user = db.users.find(u => u.alternativeId === code || u.phoneNumber === code || u.id === code);
  if (!user) {
    return res.status(404).json({ error: "Utente non trovato." });
  }

  const { password: _, ...safeUser } = user;
  res.json(safeUser);
});

// --- SOCKET.IO PER MESSAGGI E CHIAMATE VOCALI IN TEMPO REALE ---
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Mappa utenti connessi: userCode -> socketId
const userSockets = new Map();

io.on("connection", (socket) => {
  console.log(`[Socket.io] Nuova connessione: ${socket.id}`);

  // Registrazione stanza utente tramite codice 10 cifre
  socket.on("register_user", (userCode) => {
    if (userCode) {
      socket.join(userCode);
      userSockets.set(userCode, socket.id);
      console.log(`[Socket.io] Utente registrato nella stanza: ${userCode}`);
    }
  });

  // INVIO E RICEZIONE MESSAGGI IN TEMPO REALE
  socket.on("send_message", (data) => {
    const { senderCode, receiverCode, content } = data;
    const db = readDb();

    const newMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      senderCode,
      receiverCode,
      content,
      timestamp: new Date().toISOString()
    };

    db.messages.push(newMessage);
    writeDb(db);

    // Invia il messaggio al destinatario in tempo reale
    io.to(receiverCode).emit("receive_message", newMessage);
    // Conferma invio al mittente
    socket.emit("message_sent", newMessage);
  });

  // SIGNALING CHIAMATE VOCALI WEBRTC IN TEMPO REALE
  socket.on("call_user", ({ callerCode, receiverCode, offer, callerInfo }) => {
    console.log(`[VoIP] Chiamata in arrivo da ${callerCode} a ${receiverCode}`);
    io.to(receiverCode).emit("incoming_call", {
      callerCode,
      callerInfo,
      offer
    });
  });

  socket.on("answer_call", ({ callerCode, receiverCode, answer }) => {
    console.log(`[VoIP] Chiamata accettata da ${receiverCode}`);
    io.to(callerCode).emit("call_answered", { answer });
  });

  socket.on("ice_candidate", ({ targetCode, candidate }) => {
    io.to(targetCode).emit("ice_candidate", { candidate });
  });

  socket.on("reject_call", ({ callerCode }) => {
    console.log(`[VoIP] Chiamata rifiutata da destinatario`);
    io.to(callerCode).emit("call_rejected");
  });

  socket.on("hangup_call", ({ targetCode }) => {
    console.log(`[VoIP] Chiamata terminata`);
    io.to(targetCode).emit("call_ended");
  });

  socket.on("disconnect", () => {
    for (const [code, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(code);
        break;
      }
    }
    console.log(`[Socket.io] Disconnesso: ${socket.id}`);
  });
});

// Avvio Server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`================================================`);
  console.log(`🚀 Server ChatYou in esecuzione sulla porta ${PORT}`);
  console.log(`================================================`);
});