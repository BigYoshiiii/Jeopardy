import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] }
});

/** -----------------------
 *  Rooms / Sessions Model
 *  -----------------------
 *  - clientId = persistent per browser (localStorage)
 *  - rooms live in memory (MVP), with TTL
 */

const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const ROOM_CLEANUP_EVERY_MS = 60 * 1000;

const rooms = new Map(); // code -> room
const clients = new Map(); // socket.id -> {clientId, roomCode}

function makeCode(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function hashPassword(pw) {
  if (!pw) return null;
  const salt = "jeop_salt_v1";
  return crypto.createHash("sha256").update(pw + salt).digest("hex");
}

function now() { return Date.now(); }

function defaultQuiz(cols = 5, rows = 5) {
  const categories = Array.from({ length: cols }, (_, i) => `Kategorie ${i + 1}`);
  const clues = Array.from({ length: cols }, (_, c) =>
    Array.from({ length: rows }, (_, r) => ({
      q: `Frage ${c + 1}.${r + 1}`,
      a: `Antwort ${c + 1}.${r + 1}`,
      value: (r + 1) * 100,
      used: false
    }))
  );
  return { version: 1, board: { cols, rows, categories, clues } };
}

function defaultState() {
  const quiz = defaultQuiz();
  return {
    phase: "lobby", // lobby | game
    quiz,
    scores: [
      { id: crypto.randomUUID(), name: "Team 1", score: 0 },
      { id: crypto.randomUUID(), name: "Team 2", score: 0 }
    ],
    current: { open: false, col: null, row: null, showAnswer: false },
    updatedAt: now()
  };
}

function getRoom(code) {
  return rooms.get(code);
}

function ensureRoom(code) {
  const r = rooms.get(code);
  if (!r) return null;
  r.lastActivityAt = now();
  return r;
}

function isHost(room, clientId) {
  return room?.hostClientId && room.hostClientId === clientId;
}

function publicRoomSnapshot(room) {
  // what clients get
  return {
    code: room.code,
    phase: room.state.phase,
    state: room.state,
    players: Array.from(room.players.values()).map(p => ({
      clientId: p.clientId,
      name: p.name,
      role: p.role,
      ready: p.ready,
      isHost: p.clientId === room.hostClientId
    })),
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt
  };
}

function broadcastRoom(code) {
  const room = getRoom(code);
  if (!room) return;
  io.to(code).emit("room:snapshot", publicRoomSnapshot(room));
}

function assertJoinAllowed(room, role, password, clientId) {
  // Host reconnect: always allowed
  if (isHost(room, clientId)) return { ok: true };

  // Otherwise check password if set
  if (room.passwordHash) {
    const pwHash = hashPassword((password ?? "").trim());
    if (!pwHash || pwHash !== room.passwordHash) return { ok: false, error: "wrong_password" };
  }

  // Role sanity
  if (!["player", "spectator"].includes(role)) role = "player";
  return { ok: true, role };
}

function upsertPlayer(room, { clientId, name, role }) {
  const existing = room.players.get(clientId);
  if (existing) {
    existing.name = name ?? existing.name;
    existing.role = role ?? existing.role;
    existing.lastSeenAt = now();
    return existing;
  }
  const p = {
    clientId,
    name: (name ?? "Player").slice(0, 20),
    role: role ?? "player",
    ready: false,
    lastSeenAt: now()
  };
  room.players.set(clientId, p);
  return p;
}

// Cleanup old rooms
setInterval(() => {
  const t = now();
  for (const [code, room] of rooms.entries()) {
    if (t - room.lastActivityAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, ROOM_CLEANUP_EVERY_MS);

// ---------------- Socket.io ----------------

io.on("connection", (socket) => {
  socket.on("room:create", ({ clientId, name, password } = {}, cb) => {
    try {
      let code;
      do { code = makeCode(5); } while (rooms.has(code));

      const room = {
        code,
        createdAt: now(),
        lastActivityAt: now(),
        passwordHash: hashPassword((password ?? "").trim()),
        hostClientId: clientId,
        players: new Map(),
        state: defaultState()
      };

      rooms.set(code, room);

      // creator becomes host player
      upsertPlayer(room, { clientId, name: name || "Host", role: "player" });

      socket.join(code);
      clients.set(socket.id, { clientId, roomCode: code });

      cb?.({ ok: true, code, snapshot: publicRoomSnapshot(room) });
      broadcastRoom(code);
    } catch {
      cb?.({ ok: false, error: "create_failed" });
    }
  });

  socket.on("room:join", ({ code, clientId, name, role, password } = {}, cb) => {
    code = (code || "").trim().toUpperCase();
    const room = ensureRoom(code);
    if (!room) return cb?.({ ok: false, error: "room_not_found" });

    const allow = assertJoinAllowed(room, role, password, clientId);
    if (!allow.ok) return cb?.(allow);

    socket.join(code);
    clients.set(socket.id, { clientId, roomCode: code });

    // If host joins and hostClientId is empty (edge), restore
    if (!room.hostClientId) room.hostClientId = clientId;

    upsertPlayer(room, { clientId, name: name || "Player", role: allow.role || role || "player" });

    cb?.({ ok: true, snapshot: publicRoomSnapshot(room), isHost: isHost(room, clientId) });
    broadcastRoom(code);
  });

  socket.on("room:leave", (_, cb) => {
    const link = clients.get(socket.id);
    if (!link) return cb?.({ ok: true });
    const room = getRoom(link.roomCode);
    if (room) {
      socket.leave(link.roomCode);
      // keep player for reconnect; mark lastSeen
      const p = room.players.get(link.clientId);
      if (p) p.lastSeenAt = now();
      broadcastRoom(link.roomCode);
    }
    clients.delete(socket.id);
    cb?.({ ok: true });
  });

  // Lobby: ready toggle
  socket.on("player:ready", ({ ready } = {}, cb) => {
    const link = clients.get(socket.id);
    if (!link) return cb?.({ ok: false, error: "not_in_room" });
    const room = ensureRoom(link.roomCode);
    if (!room) return cb?.({ ok: false, error: "room_not_found" });
    const p = room.players.get(link.clientId);
    if (!p) return cb?.({ ok: false, error: "player_not_found" });
    p.ready = !!ready;
    room.lastActivityAt = now();
    broadcastRoom(room.code);
    cb?.({ ok: true });
  });

  // Host: start game
  socket.on("host:start", (_, cb) => {
    const link = clients.get(socket.id);
    if (!link) return cb?.({ ok: false, error: "not_in_room" });
    const room = ensureRoom(link.roomCode);
    if (!room) return cb?.({ ok: false, error: "room_not_found" });
    if (!isHost(room, link.clientId)) return cb?.({ ok: false, error: "forbidden" });

    room.state.phase = "game";
    room.state.current = { open: false, col: null, row: null, showAnswer: false };
    room.state.updatedAt = now();
    broadcastRoom(room.code);
    cb?.({ ok: true });
  });

  // Host: set room password (optional)
  socket.on("host:setPassword", ({ password } = {}, cb) => {
    const link = clients.get(socket.id);
    if (!link) return cb?.({ ok: false, error: "not_in_room" });
    const room = ensureRoom(link.roomCode);
    if (!room) return cb?.({ ok: false, error: "room_not_found" });
    if (!isHost(room, link.clientId)) return cb?.({ ok: false, error: "forbidden" });

    const pw = String(password ?? "").trim();
    room.passwordHash = pw ? hashPassword(pw) : null;
    room.lastActivityAt = now();
    broadcastRoom(room.code);
    cb?.({ ok: true });
  });

  // Host: load quiz (board)
  socket.on("host:loadQuiz", ({ quiz } = {}, cb) => {
    const link = clients.get(socket.id);
    if (!link) return cb?.({ ok: false, error: "not_in_room" });
    const room = ensureRoom(link.roomCode);
    if (!room) return cb?.({ ok: false, error: "room_not_found" });
    if (!isHost(room, link.clientId)) return cb?.({ ok: false, error: "forbidden" });

    if (!quiz?.board?.cols || !quiz?.board?.rows) return cb?.({ ok: false, error: "bad_quiz" });

    // reset used/current/scores (scores keep teams names)
    room.state.quiz = { version: 1, board: quiz.board };
    room.state.current = { open: false, col: null, row: null, showAnswer: false };
    room.state.scores = room.state.scores.map(t => ({ ...t, score: 0 }));
    room.state.updatedAt = now();
    broadcastRoom(room.code);
    cb?.({ ok: true });
  });

  // Host: game actions (open/reveal/close/used/score)
  socket.on("host:action", ({ action } = {}, cb) => {
    const link = clients.get(socket.id);
    if (!link) return cb?.({ ok: false, error: "not_in_room" });
    const room = ensureRoom(link.roomCode);
    if (!room) return cb?.({ ok: false, error: "room_not_found" });
    if (!isHost(room, link.clientId)) return cb?.({ ok: false, error: "forbidden" });

    const s = room.state;
    const b = s.quiz.board;

    try {
      if (action?.type === "open") {
        const { col, row } = action;
        if (s.phase !== "game") throw new Error("not_in_game");
        if (!b.clues?.[col]?.[row]) throw new Error("bad_cell");
        if (b.clues[col][row].used) throw new Error("used");
        s.current = { open: true, col, row, showAnswer: false };
      } else if (action?.type === "close") {
        s.current = { open: false, col: null, row: null, showAnswer: false };
      } else if (action?.type === "reveal") {
        if (!s.current.open) throw new Error("no_current");
        s.current.showAnswer = true;
      } else if (action?.type === "markUsed") {
        const { col, row, used } = action;
        if (!b.clues?.[col]?.[row]) throw new Error("bad_cell");
        b.clues[col][row].used = !!used;
      } else if (action?.type === "scoreDelta") {
        const { teamId, delta } = action;
        const t = s.scores.find(x => x.id === teamId);
        if (t) t.score += Number(delta) || 0;
      } else if (action?.type === "renameTeam") {
        const { teamId, name } = action;
        const t = s.scores.find(x => x.id === teamId);
        if (t) t.name = String(name ?? "").trim().slice(0, 20) || t.name;
      } else if (action?.type === "resetUsed") {
        for (let c = 0; c < b.cols; c++) {
          for (let r = 0; r < b.rows; r++) b.clues[c][r].used = false;
        }
      } else {
        throw new Error("unknown_action");
      }

      s.updatedAt = now();
      room.lastActivityAt = now();
      broadcastRoom(room.code);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: String(e.message || "action_failed") });
    }
  });

  socket.on("disconnect", () => {
    const link = clients.get(socket.id);
    if (!link) return;
    const room = getRoom(link.roomCode);
    if (room) {
      const p = room.players.get(link.clientId);
      if (p) p.lastSeenAt = now();
      broadcastRoom(link.roomCode);
    }
    clients.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on :${PORT}`));
