import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] }
});

// In-memory rooms (MVP). For real prod later: Redis/DB.
const rooms = new Map();

function makeCode(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function defaultState(cols = 5, rows = 5) {
  const categories = Array.from({ length: cols }, (_, i) => `Kategorie ${i + 1}`);
  const clues = Array.from({ length: cols }, (_, c) =>
    Array.from({ length: rows }, (_, r) => ({
      q: `Frage ${c + 1}.${r + 1}`,
      a: `Antwort ${c + 1}.${r + 1}`,
      value: (r + 1) * 100,
      used: false
    }))
  );
  return {
    board: { cols, rows, categories, clues },
    scores: [
      { id: crypto.randomUUID(), name: "Team 1", score: 0 },
      { id: crypto.randomUUID(), name: "Team 2", score: 0 }
    ],
    current: { open: false, col: null, row: null, showAnswer: false },
    updatedAt: Date.now()
  };
}

function getRoom(code) {
  return rooms.get(code);
}

function isHost(room, token) {
  return room && token && token === room.hostToken;
}

io.on("connection", (socket) => {
  // Create room (host)
  socket.on("room:create", (_, cb) => {
    try {
      let code;
      do { code = makeCode(5); } while (rooms.has(code));

      const hostToken = crypto.randomBytes(16).toString("hex");
      const state = defaultState();

      rooms.set(code, {
        code,
        hostToken,
        state,
        createdAt: Date.now()
      });

      cb?.({ ok: true, code, hostToken, state });
    } catch (e) {
      cb?.({ ok: false, error: "create_failed" });
    }
  });

  // Join room (viewer or host reconnect)
  socket.on("room:join", ({ code, role, hostToken }, cb) => {
    const room = getRoom(code);
    if (!room) return cb?.({ ok: false, error: "room_not_found" });

    socket.join(code);

    const asHost = role === "host" && isHost(room, hostToken);
    cb?.({
      ok: true,
      role: asHost ? "host" : "viewer",
      state: room.state
    });

    // Tell others viewer count
    const size = io.sockets.adapter.rooms.get(code)?.size ?? 0;
    io.to(code).emit("room:presence", { viewers: Math.max(0, size - 1) }); // rough
  });

  // Host updates whole state (simple MVP)
  socket.on("state:set", ({ code, hostToken, nextState }, cb) => {
    const room = getRoom(code);
    if (!isHost(room, hostToken)) return cb?.({ ok: false, error: "forbidden" });

    // Minimal sanity
    if (!nextState?.board?.cols || !nextState?.board?.rows) return cb?.({ ok: false, error: "bad_state" });

    room.state = { ...nextState, updatedAt: Date.now() };
    io.to(code).emit("state:update", room.state);
    cb?.({ ok: true });
  });

  // Host patch updates (recommended)
  socket.on("state:patch", ({ code, hostToken, patch }, cb) => {
    const room = getRoom(code);
    if (!isHost(room, hostToken)) return cb?.({ ok: false, error: "forbidden" });

    try {
      // Shallow patching by known keys (safe-ish)
      const s = room.state;
      const n = structuredClone(s);

      if (patch.type === "open") {
        n.current = { open: true, col: patch.col, row: patch.row, showAnswer: false };
        // mark used optional later; we keep manual
      } else if (patch.type === "close") {
        n.current = { open: false, col: null, row: null, showAnswer: false };
      } else if (patch.type === "reveal") {
        n.current = { ...n.current, showAnswer: true };
      } else if (patch.type === "markUsed") {
        const { col, row, used } = patch;
        n.board.clues[col][row].used = !!used;
      } else if (patch.type === "editCategory") {
        n.board.categories[patch.col] = String(patch.name ?? "").trim();
      } else if (patch.type === "editClue") {
        const cl = n.board.clues[patch.col][patch.row];
        cl.q = String(patch.q ?? "");
        cl.a = String(patch.a ?? "");
        cl.value = Number(patch.value ?? cl.value) || 0;
      } else if (patch.type === "resize") {
        const cols = Math.max(2, Math.min(10, Number(patch.cols) || 5));
        const rows = Math.max(2, Math.min(10, Number(patch.rows) || 5));
        const old = n.board;

        const categories = Array.from({ length: cols }, (_, c) => old.categories[c] ?? `Kategorie ${c + 1}`);
        const clues = Array.from({ length: cols }, (_, c) => {
          const col = old.clues[c] ?? [];
          return Array.from({ length: rows }, (_, r) => col[r] ?? ({
            q: `Frage ${c + 1}.${r + 1}`,
            a: `Antwort ${c + 1}.${r + 1}`,
            value: (r + 1) * 100,
            used: false
          }));
        });

        n.board = { cols, rows, categories, clues };
        n.current = { open: false, col: null, row: null, showAnswer: false };
      } else if (patch.type === "scoreSet") {
        n.scores = patch.scores;
      } else if (patch.type === "scoreDelta") {
        const t = n.scores.find(x => x.id === patch.teamId);
        if (t) t.score += Number(patch.delta) || 0;
      } else if (patch.type === "resetUsed") {
        for (let c = 0; c < n.board.cols; c++) {
          for (let r = 0; r < n.board.rows; r++) n.board.clues[c][r].used = false;
        }
      }

      n.updatedAt = Date.now();
      room.state = n;
      io.to(code).emit("state:update", room.state);
      cb?.({ ok: true, state: room.state });
    } catch (e) {
      cb?.({ ok: false, error: "patch_failed" });
    }
  });

  socket.on("disconnecting", () => {
    // presence updates can be improved; MVP ok.
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Jeopardy Online läuft auf http://localhost:${PORT}`);
  console.log(`Host:  http://localhost:${PORT}/host.html`);
  console.log(`View:  http://localhost:${PORT}/view.html?code=ROOM`);
});
