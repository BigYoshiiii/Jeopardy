const socket = io({ transports: ["websocket", "polling"] });

const LS = {
  clientId: "jeop_client_id_v1",
  name: "jeop_name_v1",
  lastRoom: "jeop_last_room_v1",
  quizLib: "jeop_quiz_library_v1"
};

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getClientId() {
  let id = localStorage.getItem(LS.clientId);
  if (!id) { id = uuid(); localStorage.setItem(LS.clientId, id); }
  return id;
}

function getName() { return localStorage.getItem(LS.name) || ""; }
function setName(n) { localStorage.setItem(LS.name, n); }

function setHash(path) { location.hash = path; }

function parseRoute() {
  const h = (location.hash || "#/").slice(1);
  const parts = h.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "room" && parts[1]) return { name: "room", code: parts[1].toUpperCase() };
  return { name: "home" };
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function quizLibGet() {
  try { return JSON.parse(localStorage.getItem(LS.quizLib) || "[]"); }
  catch { return []; }
}
function quizLibSet(list) { localStorage.setItem(LS.quizLib, JSON.stringify(list)); }

const app = document.getElementById("app");

const client = {
  clientId: getClientId(),
  name: getName(),
  roomCode: null,
  snapshot: null,
  isHost: false,
  role: "player",
  joinPassword: "",
  editMode: "play", // host: play | edit
  selected: null,   // host: {type:"cat", col} | {type:"clue", col, row}
  activeTeamId: null
};

// ---------- UI Shell ----------
function renderShell(innerHtml) {
  app.innerHTML = `
    <div class="topbar">
      <div class="wrap row space">
        <div class="row">
          <div class="badge">JEOPARDY</div>
          <h1>Jeopardy Online</h1>
        </div>
        <div class="row">
          <span class="pill">${client.name ? `Name: ${esc(client.name)}` : "Kein Name"}</span>
          <span class="pill">${client.roomCode ? `Room: ${client.roomCode}` : "Room: —"}</span>
          <a class="pill" href="#/">Home</a>
        </div>
      </div>
    </div>
    <div class="wrap">${innerHtml}</div>
    ${renderModal()}
  `;
  wireModal();
}

function renderModal() {
  return `
    <div class="modal" id="modal">
      <div class="dialog">
        <div class="hd">
          <div class="row space">
            <div class="row">
              <span class="pill" id="mCat">—</span>
              <span class="pill" id="mVal">—</span>
            </div>
            <div class="row">
              <button id="mReveal">Antwort</button>
              <button id="mUsed" class="primary">Used</button>
              <button id="mClose">Close</button>
            </div>
          </div>
        </div>
        <div class="bd">
          <p class="big" id="mQ">—</p>
          <div class="answer" id="mABox">
            <div class="small">Antwort</div>
            <div style="font-weight:950;font-size:18px" id="mA">—</div>
          </div>
          <div class="row" style="margin-top:14px;justify-content:space-between">
            <div class="row" id="mScore"></div>
            <div class="small">Host kontrolliert. Alle sehen live.</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function wireModal() {
  const modal = document.getElementById("modal");
  const btnClose = document.getElementById("mClose");
  const btnReveal = document.getElementById("mReveal");
  const btnUsed = document.getElementById("mUsed");

  btnClose?.addEventListener("click", () => hostAction({ type: "close" }));
  modal?.addEventListener("click", (e) => { if (e.target === modal) hostAction({ type: "close" }); });

  btnReveal?.addEventListener("click", () => hostAction({ type: "reveal" }));
  btnUsed?.addEventListener("click", () => {
    const s = client.snapshot?.state;
    if (!s?.current?.open) return;
    hostAction({ type: "markUsed", col: s.current.col, row: s.current.row, used: true });
  });
}

// ---------- Pages ----------
function pageHome() {
  renderShell(`
    <div class="grid two">
      <section class="card">
        <div class="hd"><h2>Start</h2></div>
        <div class="bd">
          <p>Wie bei Gartic: Name rein, Room erstellen oder joinen.</p>
          <div style="margin-top:12px" class="row">
            <input id="name" placeholder="Dein Name" value="${esc(client.name)}" style="max-width:280px"/>
            <select id="role" style="max-width:180px">
              <option value="player" ${client.role==="player"?"selected":""}>Player</option>
              <option value="spectator" ${client.role==="spectator"?"selected":""}>Spectator</option>
            </select>
          </div>

          <div style="margin-top:12px" class="row">
            <input id="createPw" placeholder="Room Passwort (optional)" style="max-width:280px"/>
            <button class="primary" id="createBtn">Create Room</button>
          </div>

          <div style="margin-top:12px" class="row">
            <input id="joinCode" placeholder="Room Code (ABCDE)" style="max-width:180px"/>
            <input id="joinPw" placeholder="Passwort (falls gesetzt)" style="max-width:280px"/>
            <button class="primary" id="goJoin">Join</button>
          </div>

          <div style="margin-top:12px" class="small">
            Join-Link: <span class="pill">#/room/ABCDE</span>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="hd"><h2>Quiz Library (local)</h2></div>
        <div class="bd" id="libBox"></div>
      </section>
    </div>
  `);

  const lib = quizLibGet();
  const libBox = document.getElementById("libBox");
  libBox.innerHTML = `
    <div style="margin-bottom:10px" class="small">Speichert im Browser. Nicht global.</div>
    <div class="row">
      <label class="pill" style="cursor:pointer">
        Import JSON
        <input id="importQuiz" type="file" accept="application/json" style="display:none">
      </label>
      <button id="exportBlank">Export Blank Quiz</button>
    </div>
    <div style="margin-top:12px" class="list">
      ${lib.length ? lib.map((x,i)=>`
        <div class="item">
          <div class="kv">
            <div>
              <div style="font-weight:950">${esc(x.name)}</div>
              <div class="small">${esc(x.savedAt)}</div>
            </div>
            <div class="row">
              <button data-del="${i}" class="bad">Delete</button>
            </div>
          </div>
        </div>
      `).join("") : `<div class="small">Noch nix gespeichert. Import erstmal.</div>`}
    </div>
  `;

  document.getElementById("createBtn").addEventListener("click", () => {
    const name = (document.getElementById("name").value || "").trim();
    const role = document.getElementById("role").value;
    const pw = (document.getElementById("createPw").value || "").trim();
    if (!name) return alert("Name fehlt.");
    client.name = name; client.role = role;
    setName(name);

    socket.emit("room:create", { clientId: client.clientId, name, password: pw }, (res) => {
      if (!res?.ok) return alert("Create failed.");
      client.isHost = true;
      client.snapshot = res.snapshot;
      client.roomCode = res.code;
      client.editMode = "play";
      client.selected = null;
      localStorage.setItem(LS.lastRoom, res.code);
      setHash(`/room/${res.code}`);
    });
  });

  document.getElementById("goJoin").addEventListener("click", () => {
    const name = (document.getElementById("name").value || "").trim();
    const role = document.getElementById("role").value;
    const code = (document.getElementById("joinCode").value || "").trim().toUpperCase();
    const pw = (document.getElementById("joinPw").value || "").trim();
    if (!name) return alert("Name fehlt.");
    if (!code) return alert("Room Code fehlt.");
    client.name = name; client.role = role; client.joinPassword = pw;
    setName(name);
    setHash(`/room/${code}`);
  });

  document.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.getAttribute("data-del"));
      const list = quizLibGet();
      list.splice(i,1);
      quizLibSet(list);
      pageHome();
    });
  });

  document.getElementById("exportBlank").addEventListener("click", () => {
    const quiz = makeBlankQuiz(5,5);
    downloadJson(quiz, "jeopardy_quiz_blank.json");
  });

  document.getElementById("importQuiz").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const quiz = JSON.parse(r.result);
        if (!quiz?.board?.cols || !quiz?.board?.rows) throw new Error("bad");
        const name = prompt("Name für die Library:", "Imported Quiz");
        if (!name) return;
        const list = quizLibGet();
        list.unshift({ name, savedAt: new Date().toISOString(), quiz });
        quizLibSet(list.slice(0,50));
        pageHome();
      } catch {
        alert("Import failed: ungültiges JSON.");
      }
    };
    r.readAsText(f);
    e.target.value = "";
  });
}

function pageRoom(code) {
  renderShell(`
    <div class="grid two">
      <section class="card">
        <div class="hd">
          <div class="row space">
            <h2>Room ${esc(code)}</h2>
            <div class="row">
              <span class="pill" id="phasePill">phase: —</span>
              <button id="copyLink">Copy Join Link</button>
              <button id="leave">Leave</button>
            </div>
          </div>
        </div>
        <div class="bd" id="left"></div>
      </section>

      <section class="card">
        <div class="hd">
          <div class="row space">
            <h2>Controls</h2>
            <span class="pill" id="youPill">—</span>
          </div>
        </div>
        <div class="bd" id="right"></div>
      </section>
    </div>
  `);

  document.getElementById("copyLink").addEventListener("click", async () => {
    const link = `${location.origin}${location.pathname}#/room/${code}`;
    try { await navigator.clipboard.writeText(link); alert("Link kopiert."); }
    catch { prompt("Copy:", link); }
  });

  document.getElementById("leave").addEventListener("click", () => {
    socket.emit("room:leave", null, () => {
      client.roomCode = null;
      client.snapshot = null;
      client.isHost = false;
      client.selected = null;
      client.editMode = "play";
      setHash("/");
    });
  });

  const name = client.name || getName();
  if (!name) {
    alert("Setz erst deinen Namen.");
    return setHash("/");
  }
  client.roomCode = code;

  socket.emit("room:join", {
    code,
    clientId: client.clientId,
    name,
    role: client.role,
    password: client.joinPassword
  }, (res) => {
    if (!res?.ok) {
      if (res.error === "wrong_password") {
        const pw = prompt("Room Passwort:");
        if (!pw) return setHash("/");
        client.joinPassword = pw;
        return pageRoom(code);
      }
      alert("Join failed: " + res.error);
      return setHash("/");
    }
    client.snapshot = res.snapshot;
    client.isHost = !!res.isHost;
    client.selected = null;
    localStorage.setItem(LS.lastRoom, code);
    renderRoom();
  });

  function ensureActiveTeam(s) {
    if (!s?.scores?.length) return;
    if (!client.activeTeamId) client.activeTeamId = s.scores[0].id;
    if (!s.scores.find(t => t.id === client.activeTeamId)) client.activeTeamId = s.scores[0].id;
  }

  function renderRoom() {
    const snap = client.snapshot;
    if (!snap) return;

    document.getElementById("phasePill").textContent = `phase: ${snap.phase}`;
    document.getElementById("youPill").textContent =
      client.isHost ? "Du bist Host" : (client.role === "spectator" ? "Du bist Spectator" : "Du bist Player");

    const left = document.getElementById("left");
    const right = document.getElementById("right");

    // LOBBY
    if (snap.phase === "lobby") {
      left.innerHTML = `
        <div class="pill">Lobby</div>
        <div style="margin-top:10px" class="list">
          ${snap.players.map(p => `
            <div class="item">
              <div class="kv">
                <div>
                  <div style="font-weight:950">${esc(p.name)} ${p.isHost ? '<span class="pill">HOST</span>' : ""}</div>
                  <div class="small">${esc(p.role)} · ${p.ready ? "ready" : "not ready"}</div>
                </div>
                <div>${p.ready ? `<span class="pill">READY</span>` : `<span class="pill">…</span>`}</div>
              </div>
            </div>
          `).join("")}
        </div>
      `;

      const me = snap.players.find(p => p.clientId === client.clientId);
      const isReady = !!me?.ready;

      right.innerHTML = `
        <div class="pill">Lobby Controls</div>
        <div style="margin-top:10px" class="row">
          <button class="${isReady ? "good" : "primary"}" id="readyBtn">${isReady ? "Unready" : "Ready"}</button>
          ${client.isHost ? `<button class="primary" id="startBtn">Start Game</button>` : ""}
        </div>

        ${client.isHost ? `
          <div style="margin-top:14px" class="pill">Host Settings</div>
          <div style="margin-top:10px" class="row">
            <input id="newPw" placeholder="Room Passwort (leer = aus)" />
            <button id="setPw">Set</button>
          </div>
          <div style="margin-top:10px" class="row">
            <label class="pill" style="cursor:pointer">
              Load Quiz JSON
              <input id="loadQuizFile" type="file" accept="application/json" style="display:none">
            </label>
            <button id="exportQuiz">Export Current Quiz</button>
            <button id="saveToLib">Save to Library</button>
          </div>
        ` : `<div class="small" style="margin-top:14px">Warte bis Host startet.</div>`}
      `;

      document.getElementById("readyBtn").addEventListener("click", () => {
        socket.emit("player:ready", { ready: !isReady });
      });

      if (client.isHost) {
        document.getElementById("startBtn")?.addEventListener("click", () => socket.emit("host:start", null, (r)=>{ if(!r?.ok) alert(r.error); }));

        document.getElementById("setPw")?.addEventListener("click", () => {
          const pw = (document.getElementById("newPw").value || "").trim();
          socket.emit("host:setPassword", { password: pw }, (r)=> {
            if (!r?.ok) alert(r.error);
            else alert(pw ? "Passwort gesetzt." : "Passwort entfernt.");
          });
        });

        document.getElementById("exportQuiz")?.addEventListener("click", () => {
          downloadJson(snap.state.quiz, `jeopardy_quiz_${snap.code}.json`);
        });

        document.getElementById("saveToLib")?.addEventListener("click", () => {
          const name = prompt("Name fürs Quiz:", "My Quiz");
          if (!name) return;
          const list = quizLibGet();
          list.unshift({ name, savedAt: new Date().toISOString(), quiz: snap.state.quiz });
          quizLibSet(list.slice(0,50));
          alert("Gespeichert (local).");
        });

        document.getElementById("loadQuizFile")?.addEventListener("change", (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const r = new FileReader();
          r.onload = () => {
            try {
              const quiz = JSON.parse(r.result);
              socket.emit("host:loadQuiz", { quiz }, (resp) => {
                if (!resp?.ok) alert("Load failed: " + resp.error);
              });
            } catch { alert("Ungültiges Quiz JSON."); }
          };
          r.readAsText(f);
          e.target.value = "";
        });
      }
      return;
    }

    // GAME
    const s = snap.state;
    ensureActiveTeam(s);
    const b = s.quiz.board;

    left.innerHTML = `
      <div class="pill">Board</div>
      <div style="margin-top:10px" id="board" class="board"></div>
      <div style="margin-top:10px" class="small">
        ${client.isHost ? `Mode: <span class="pill">${client.editMode.toUpperCase()}</span>` : `Live View`}
      </div>
    `;

    const boardEl = document.getElementById("board");
    boardEl.style.gridTemplateColumns = `repeat(${b.cols}, 1fr)`;
    boardEl.style.gridTemplateRows = `auto repeat(${b.rows}, 1fr)`;

    // categories
    for (let c=0;c<b.cols;c++){
      const t = document.createElement("div");
      t.className = "tile cat";
      t.textContent = b.categories[c] ?? `Kategorie ${c+1}`;

      if (client.isHost && client.editMode === "edit") {
        t.title = "Kategorie bearbeiten";
        t.addEventListener("click", () => {
          client.selected = { type: "cat", col: c };
          renderRoom();
        });
      } else {
        t.style.cursor = "default";
      }

      boardEl.appendChild(t);
    }

    // cells
    for (let r=0;r<b.rows;r++){
      for (let c=0;c<b.cols;c++){
        const cl = b.clues[c][r];
        const t = document.createElement("div");
        t.className = "tile" + (cl.used ? " used" : "");
        t.textContent = cl.value ?? (r+1)*100;

        if (client.isHost) {
          t.addEventListener("click", () => {
            if (client.editMode === "edit") {
              client.selected = { type:"clue", col:c, row:r };
              renderRoom();
              return;
            }
            if (cl.used) return;
            hostAction({ type:"open", col:c, row:r });
          });
        } else {
          t.style.cursor = "default";
        }

        boardEl.appendChild(t);
      }
    }

    right.innerHTML = `
      <div class="pill">Scores</div>
      <div style="margin-top:10px" class="list">
        ${s.scores.map(t => `
          <div class="item">
            <div class="kv">
              <div>
                <div style="font-weight:950">${esc(t.name)}</div>
                <div class="small">${t.score} Punkte</div>
              </div>
              ${client.isHost ? `
                <div class="row">
                  <button class="good" data-delta="${t.id}" data-v="100">+100</button>
                  <button class="bad" data-delta="${t.id}" data-v="-100">-100</button>
                  <button data-rename="${t.id}">Rename</button>
                </div>
              ` : ``}
            </div>
          </div>
        `).join("")}
      </div>

      ${client.isHost ? `
        <div style="margin-top:14px" class="pill">Host Controls</div>
        <div style="margin-top:10px" class="row">
          <button id="modePlay" class="${client.editMode==="play" ? "primary" : ""}">PLAY</button>
          <button id="modeEdit" class="${client.editMode==="edit" ? "primary" : ""}">EDIT</button>
          <button id="resetUsed">Reset Used</button>
        </div>

        <div style="margin-top:12px" class="card" style="box-shadow:none;background:rgba(255,255,255,.03)">
          <div class="bd" id="editorBox"></div>
        </div>
      ` : `<div style="margin-top:14px" class="small">Du bist ${client.role}. Host steuert.</div>`}
    `;

    // host wiring (scores)
    if (client.isHost) {
      document.querySelectorAll("[data-delta]").forEach(btn => {
        btn.addEventListener("click", () => {
          const teamId = btn.getAttribute("data-delta");
          const delta = Number(btn.getAttribute("data-v")) || 0;
          hostAction({ type:"scoreDelta", teamId, delta });
        });
      });

      document.querySelectorAll("[data-rename]").forEach(btn => {
        btn.addEventListener("click", () => {
          const teamId = btn.getAttribute("data-rename");
          const name = prompt("Team Name:");
          if (!name) return;
          hostAction({ type:"renameTeam", teamId, name });
        });
      });

      document.getElementById("resetUsed")?.addEventListener("click", () => hostAction({ type:"resetUsed" }));

      document.getElementById("modePlay")?.addEventListener("click", () => {
        client.editMode = "play";
        client.selected = null;
        renderRoom();
      });
      document.getElementById("modeEdit")?.addEventListener("click", () => {
        client.editMode = "edit";
        renderRoom();
      });

      // EDITOR PANEL
      const box = document.getElementById("editorBox");
      if (box) {
        if (client.editMode !== "edit") {
          box.innerHTML = `<div class="small">EDIT ist aus. Stell auf EDIT um, um Fragen zu bearbeiten.</div>`;
        } else if (!client.selected) {
          box.innerHTML = `<div class="small">Klick links eine Kategorie oder ein Feld. Dann bearbeiten.</div>`;
        } else {
          if (client.selected.type === "cat") {
            const col = client.selected.col;
            const cur = b.categories[col] ?? "";
            box.innerHTML = `
              <div class="pill">Kategorie</div>
              <div style="margin-top:10px" class="small">Spalte ${col + 1}</div>
              <div style="margin-top:10px">
                <div class="small">Name</div>
                <input id="catName" value="${esc(cur)}" />
              </div>
              <div style="margin-top:10px" class="row">
                <button class="primary" id="saveCat">Speichern</button>
              </div>
            `;
            document.getElementById("saveCat")?.addEventListener("click", () => {
              const name = (document.getElementById("catName").value || "").trim();
              hostAction({ type: "editCategory", col, name });
            });
          }

          if (client.selected.type === "clue") {
            const { col, row } = client.selected;
            const cl = b.clues[col][row];
            box.innerHTML = `
              <div class="pill">Frage</div>
              <div style="margin-top:10px" class="small">${esc(b.categories[col] || "Kategorie")} · Reihe ${row + 1}</div>

              <div style="margin-top:10px">
                <div class="small">Frage</div>
                <textarea id="qBox">${esc(cl.q ?? "")}</textarea>
              </div>

              <div style="margin-top:10px">
                <div class="small">Antwort</div>
                <textarea id="aBox">${esc(cl.a ?? "")}</textarea>
              </div>

              <div style="margin-top:10px">
                <div class="small">Punkte</div>
                <input id="vBox" type="number" value="${Number(cl.value ?? 0)}" />
              </div>

              <div style="margin-top:10px" class="row">
                <button class="primary" id="saveClue">Speichern</button>
                <button id="toggleUsed">${cl.used ? "Un-used" : "Used"}</button>
              </div>
            `;

            document.getElementById("saveClue")?.addEventListener("click", () => {
              const q = (document.getElementById("qBox").value || "").trim();
              const a = (document.getElementById("aBox").value || "").trim();
              const value = Number(document.getElementById("vBox").value) || 0;
              hostAction({ type: "editClue", col, row, q, a, value });
            });

            document.getElementById("toggleUsed")?.addEventListener("click", () => {
              hostAction({ type: "markUsed", col, row, used: !cl.used });
            });
          }
        }
      }
    }

    renderModalState();
  }

  function renderModalState() {
    const snap = client.snapshot;
    const modal = document.getElementById("modal");
    const mCat = document.getElementById("mCat");
    const mVal = document.getElementById("mVal");
    const mQ = document.getElementById("mQ");
    const mA = document.getElementById("mA");
    const mABox = document.getElementById("mABox");
    const mScore = document.getElementById("mScore");

    const s = snap?.state;
    if (!s?.current?.open) {
      modal.classList.remove("open");
      return;
    }
    const { col, row } = s.current;
    const b = s.quiz.board;
    const cl = b.clues[col][row];

    mCat.textContent = b.categories[col] ?? "—";
    mVal.textContent = `${cl.value ?? 0} Punkte`;
    mQ.textContent = cl.q || "(keine Frage)";
    mA.textContent = cl.a || "(keine Antwort)";
    if (s.current.showAnswer) mABox.classList.add("open");
    else mABox.classList.remove("open");

    if (client.isHost) {
      if (!client.activeTeamId) client.activeTeamId = s.scores[0]?.id || null;
      mScore.innerHTML = `
        <select id="teamPick" style="max-width:220px">
          ${s.scores.map(t => `<option value="${t.id}" ${t.id===client.activeTeamId?"selected":""}>${esc(t.name)}</option>`).join("")}
        </select>
        <button class="good" id="addPts">Richtig +</button>
        <button class="bad" id="subPts">Falsch -</button>
      `;
      document.getElementById("teamPick").onchange = (e) => client.activeTeamId = e.target.value;
      document.getElementById("addPts").onclick = () => {
        const teamId = document.getElementById("teamPick").value;
        hostAction({ type:"scoreDelta", teamId, delta: Number(cl.value)||0 });
      };
      document.getElementById("subPts").onclick = () => {
        const teamId = document.getElementById("teamPick").value;
        hostAction({ type:"scoreDelta", teamId, delta: -(Number(cl.value)||0) });
      };
    } else {
      mScore.innerHTML = `<div class="small">Warte auf Host…</div>`;
    }

    modal.classList.add("open");
  }

  function hostAction(action) {
    if (!client.isHost) return;
    socket.emit("host:action", { action }, (res) => {
      if (!res?.ok) alert("Host action blocked: " + res.error);
    });
  }

  socket.off("room:snapshot");
  socket.on("room:snapshot", (snap) => {
    if (snap.code !== client.roomCode) return;
    client.snapshot = snap;
    client.isHost = snap.players.some(p => p.clientId === client.clientId && p.isHost);
    renderRoom();
  });
}

// ---------- Helpers ----------
function makeBlankQuiz(cols, rows) {
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

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ---------- Router ----------
function renderRoute() {
  const r = parseRoute();
  if (r.name === "home") return pageHome();
  if (r.name === "room") return pageRoom(r.code);
  pageHome();
}

window.addEventListener("hashchange", renderRoute);
if (!location.hash) location.hash = "#/";
renderRoute();
