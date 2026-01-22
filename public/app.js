window.JEOPARDY_BOOT = function boot({ role }) {
  const $ = (s, el = document) => el.querySelector(s);

  const socket = io({ transports: ["websocket", "polling"] });

  const ui = {
    board: $("#board"),
    side: $("#side"),
    infoPill: $("#infoPill"),
    roomPill: $("#roomPill"),
    viewerPill: $("#viewerPill"),
    modePill: $("#modePill"),
    modal: $("#modal"),
    mCat: $("#mCat"),
    mVal: $("#mVal"),
    mQ: $("#mQ"),
    mA: $("#mA"),
    mABox: $("#mABox"),
    btnClose: $("#btnClose"),
    btnReveal: $("#btnReveal"),
    btnUsed: $("#btnUsed"),
    scoreControls: $("#scoreControls"),
    btnCreate: $("#btnCreate"),
    btnCopy: $("#btnCopy"),
    btnModeEdit: $("#btnModeEdit"),
    btnModePlay: $("#btnModePlay"),
    btnResize: $("#btnResize"),
    btnResetUsed: $("#btnResetUsed"),
  };

  const state = {
    role,
    code: null,
    hostToken: null,
    mode: "edit", // host only
    data: null,
    selected: null, // {type:"cat", col} | {type:"clue", col,row}
    activeTeamId: null,
  };

  // ---------- Helpers ----------
  const esc = (str) => String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function setMode(m) {
    state.mode = m;
    if (ui.modePill) ui.modePill.textContent = `Mode: ${m.toUpperCase()}`;
    renderAll();
  }

  function patch(patchObj) {
    if (state.role !== "host") return;
    socket.emit("state:patch", { code: state.code, hostToken: state.hostToken, patch: patchObj }, (res) => {
      if (!res?.ok) alert(`Blocked: ${res?.error || "unknown"}`);
    });
  }

  function ensureActiveTeam() {
    if (!state.data?.scores?.length) return;
    if (!state.activeTeamId) state.activeTeamId = state.data.scores[0].id;
    if (!state.data.scores.find(t => t.id === state.activeTeamId)) {
      state.activeTeamId = state.data.scores[0].id;
    }
  }

  // ---------- Rendering ----------
  function renderAll() {
    if (!state.data) return;
    ensureActiveTeam();
    renderBoard();
    renderSide();
    renderModal();
    ui.infoPill && (ui.infoPill.textContent = `${state.data.board.cols} Kategorien · ${state.data.board.rows} Reihen`);
  }

  function renderBoard() {
    const b = state.data.board;
    ui.board.innerHTML = "";
    ui.board.style.gridTemplateColumns = `repeat(${b.cols}, 1fr)`;
    ui.board.style.gridTemplateRows = `auto repeat(${b.rows}, 1fr)`;

    // categories
    for (let c = 0; c < b.cols; c++) {
      const t = document.createElement("div");
      t.className = "tile cat";
      t.textContent = b.categories[c] ?? `Kategorie ${c + 1}`;

      if (state.role === "host") {
        t.title = "Kategorie auswählen";
        t.addEventListener("click", () => {
          state.selected = { type: "cat", col: c };
          renderSide();
        });
      } else {
        t.style.cursor = "default";
      }

      ui.board.appendChild(t);
    }

    // values
    for (let r = 0; r < b.rows; r++) {
      for (let c = 0; c < b.cols; c++) {
        const cl = b.clues[c][r];
        const t = document.createElement("div");
        t.className = "tile" + (cl.used ? " used" : "");
        t.textContent = cl.value ?? (r + 1) * 100;

        if (state.role === "host") {
          if (state.mode === "edit") {
            t.title = "Frage auswählen";
            t.addEventListener("click", () => {
              state.selected = { type: "clue", col: c, row: r };
              renderSide();
            });
          } else {
            t.title = cl.used ? "Schon benutzt" : "Öffnen";
            t.addEventListener("click", () => {
              if (cl.used) return;
              patch({ type: "open", col: c, row: r });
            });
          }
        } else {
          t.style.cursor = "default";
        }

        ui.board.appendChild(t);
      }
    }
  }

  function renderSide() {
    const d = state.data;
    if (!d) return;

    // Viewer side (falls du app.js auch in view nutzt): nur Scores + Status
    if (state.role !== "host") {
      ui.side.innerHTML = `
        <div class="pill">Scores</div>
        <div style="margin-top:10px;display:grid;gap:10px">
          ${d.scores.map(t => `
            <div class="card" style="box-shadow:none;background:rgba(255,255,255,.03);border-radius:16px">
              <div class="bd">
                <div class="row" style="justify-content:space-between;align-items:center">
                  <div style="font-weight:950">${esc(t.name)}</div>
                  <div style="font-weight:950;font-size:20px">${t.score}</div>
                </div>
              </div>
            </div>
          `).join("")}
        </div>
        <div style="margin-top:14px" class="muted">
          ${d.current.open ? "Frage ist offen." : "Keine offene Frage."}
        </div>
      `;
      return;
    }

    // Host side: Teams + Editor
    const teams = d.scores.map(t => {
      const active = (t.id === state.activeTeamId);
      return `
        <div class="card" style="box-shadow:none;background:rgba(255,255,255,.03);border-radius:16px;border:${active ? "1px solid rgba(41,208,127,.45)" : "1px solid rgba(255,255,255,.08)"}">
          <div class="bd">
            <div class="row" style="justify-content:space-between;align-items:center">
              <div style="font-weight:950">${esc(t.name)}</div>
              <div style="font-weight:950;font-size:20px">${t.score}</div>
            </div>
            <div class="row" style="margin-top:10px">
              <button class="ghost" data-team-active="${t.id}">${active ? "Aktiv ✓" : "Aktiv"}</button>
              <button class="good" data-team-delta="${t.id}" data-d="100">+100</button>
              <button class="bad" data-team-delta="${t.id}" data-d="-100">-100</button>
              <button class="ghost" data-team-rename="${t.id}">Rename</button>
            </div>
          </div>
        </div>
      `;
    }).join("");

    const sel = state.selected;
    let editor = `<div class="muted">Klick links eine Kategorie oder ein Feld, dann bearbeiten.</div>`;

    if (sel?.type === "cat") {
      const cur = d.board.categories[sel.col] ?? "";
      editor = `
        <div class="pill">Kategorie bearbeiten</div>
        <div style="margin-top:10px" class="muted">Spalte ${sel.col + 1}</div>
        <div style="margin-top:10px">
          <div class="small muted" style="margin-bottom:6px">Name</div>
          <input id="catName" value="${esc(cur)}" />
        </div>
        <div class="row" style="margin-top:10px">
          <button class="primary" id="saveCat">Speichern</button>
        </div>
      `;
    }

    if (sel?.type === "clue") {
      const cl = d.board.clues[sel.col][sel.row];
      const cat = d.board.categories[sel.col] ?? `Kategorie ${sel.col + 1}`;
      editor = `
        <div class="pill">Frage bearbeiten</div>
        <div style="margin-top:10px" class="muted">${esc(cat)} · Reihe ${sel.row + 1}</div>

        <div style="margin-top:10px">
          <div class="small muted" style="margin-bottom:6px">Frage</div>
          <textarea id="clueQ">${esc(cl.q ?? "")}</textarea>
        </div>

        <div style="margin-top:10px">
          <div class="small muted" style="margin-bottom:6px">Antwort</div>
          <textarea id="clueA">${esc(cl.a ?? "")}</textarea>
        </div>

        <div style="margin-top:10px">
          <div class="small muted" style="margin-bottom:6px">Punkte</div>
          <input id="clueV" type="number" value="${Number(cl.value ?? 0)}"/>
        </div>

        <div class="row" style="margin-top:10px">
          <button class="primary" id="saveClue">Speichern</button>
          <button class="ghost" id="toggleUsed">${cl.used ? "Un-used" : "Used"}</button>
        </div>
      `;
    }

    ui.side.innerHTML = `
      <div class="pill">Teams</div>
      <div style="margin-top:10px;display:grid;gap:10px">
        ${teams}
      </div>
      <div style="margin-top:14px" class="card" style="box-shadow:none">
        <div class="bd">
          ${editor}
        </div>
      </div>
    `;

    // Wire team buttons
    ui.side.querySelectorAll("[data-team-active]").forEach(btn => {
      btn.addEventListener("click", () => {
        state.activeTeamId = btn.getAttribute("data-team-active");
        renderSide();
      });
    });
    ui.side.querySelectorAll("[data-team-delta]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-team-delta");
        const delta = Number(btn.getAttribute("data-d")) || 0;
        patch({ type: "scoreDelta", teamId: id, delta });
      });
    });
    ui.side.querySelectorAll("[data-team-rename]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-team-rename");
        const cur = d.scores.find(x => x.id === id)?.name ?? "";
        const name = prompt("Team-Name:", cur);
        if (name == null) return;
        const next = d.scores.map(x => x.id === id ? { ...x, name: name.trim() || x.name } : x);
        patch({ type: "scoreSet", scores: next });
      });
    });

    // Wire editor save
    if (sel?.type === "cat") {
      $("#saveCat")?.addEventListener("click", () => {
        const name = ($("#catName").value || "").trim();
        patch({ type: "editCategory", col: sel.col, name });
      });
    }

    if (sel?.type === "clue") {
      $("#saveClue")?.addEventListener("click", () => {
        const q = ($("#clueQ").value || "").trim();
        const a = ($("#clueA").value || "").trim();
        const value = Number($("#clueV").value) || 0;
        patch({ type: "editClue", col: sel.col, row: sel.row, q, a, value });
      });
      $("#toggleUsed")?.addEventListener("click", () => {
        const curUsed = d.board.clues[sel.col][sel.row].used;
        patch({ type: "markUsed", col: sel.col, row: sel.row, used: !curUsed });
      });
    }
  }

  function renderModal() {
    const d = state.data;
    if (!d) return;

    if (!d.current.open) {
      ui.modal?.classList.remove("open");
      return;
    }

    const { col, row } = d.current;
    const cl = d.board.clues[col][row];

    ui.mCat.textContent = d.board.categories[col] ?? "—";
    ui.mVal.textContent = `${cl.value ?? 0} Punkte`;
    ui.mQ.textContent = cl.q || "(keine Frage)";
    ui.mA.textContent = cl.a || "(keine Antwort)";

    if (d.current.showAnswer) ui.mABox.classList.add("open");
    else ui.mABox.classList.remove("open");

    ui.modal.classList.add("open");

    // Host: Score controls inside modal (active team)
    if (state.role === "host" && ui.scoreControls) {
      ui.scoreControls.innerHTML = `
        <button class="good" id="mRight">Richtig (+)</button>
        <button class="bad" id="mWrong">Falsch (-)</button>
        <select id="teamSel" style="max-width:240px">
          ${d.scores.map(t => `<option value="${t.id}" ${t.id===state.activeTeamId?"selected":""}>${esc(t.name)}</option>`).join("")}
        </select>
      `;

      $("#teamSel")?.addEventListener("change", (e) => {
        state.activeTeamId = e.target.value;
        renderSide();
      });

      $("#mRight")?.addEventListener("click", () => {
        patch({ type: "scoreDelta", teamId: state.activeTeamId, delta: Number(cl.value) || 0 });
      });
      $("#mWrong")?.addEventListener("click", () => {
        patch({ type: "scoreDelta", teamId: state.activeTeamId, delta: -(Number(cl.value) || 0) });
      });
    }
  }

  // ---------- Host controls wiring ----------
  if (state.role === "host") {
    ui.btnModeEdit?.addEventListener("click", () => setMode("edit"));
    ui.btnModePlay?.addEventListener("click", () => setMode("play"));

    ui.btnResize?.addEventListener("click", () => {
      if (!state.data) return;
      const cols = Number(prompt("Kategorien (2-10):", String(state.data.board.cols)));
      if (!isFinite(cols)) return;
      const rows = Number(prompt("Reihen (2-10):", String(state.data.board.rows)));
      if (!isFinite(rows)) return;
      patch({ type: "resize", cols, rows });
    });

    ui.btnResetUsed?.addEventListener("click", () => {
      if (confirm("Alle Felder wieder auf unbenutzt setzen?")) patch({ type: "resetUsed" });
    });

    ui.btnCreate?.addEventListener("click", () => {
      socket.emit("room:create", null, (res) => {
        if (!res?.ok) return alert("Room erstellen ging nicht.");
        state.code = res.code;
        state.hostToken = res.hostToken;
        state.data = res.state;
        state.selected = null;

        ui.roomPill.textContent = `Room: ${state.code}`;
        localStorage.setItem("jeop_host_code", state.code);
        localStorage.setItem("jeop_host_token", state.hostToken);

        socket.emit("room:join", { code: state.code, role: "host", hostToken: state.hostToken }, (jr) => {
          if (!jr?.ok) return alert("Join failed.");
          state.data = jr.state;
          renderAll();
        });
      });
    });

    ui.btnCopy?.addEventListener("click", async () => {
      if (!state.code) return;
      const url = `${location.origin}/view.html?code=${state.code}`;
      try { await navigator.clipboard.writeText(url); alert("Viewer-Link kopiert."); }
      catch { prompt("Copy das hier:", url); }
    });

    // Modal
    ui.btnClose?.addEventListener("click", () => patch({ type: "close" }));
    ui.modal?.addEventListener("click", (e) => { if (e.target === ui.modal) patch({ type: "close" }); });
    ui.btnReveal?.addEventListener("click", () => patch({ type: "reveal" }));
    ui.btnUsed?.addEventListener("click", () => {
      const d = state.data;
      if (!d?.current?.open) return;
      patch({ type: "markUsed", col: d.current.col, row: d.current.row, used: true });
    });

    // Auto reconnect
    const savedCode = localStorage.getItem("jeop_host_code");
    const savedToken = localStorage.getItem("jeop_host_token");
    if (savedCode && savedToken) {
      state.code = savedCode;
      state.hostToken = savedToken;
      ui.roomPill.textContent = `Room: ${state.code}`;
      socket.emit("room:join", { code: state.code, role: "host", hostToken: state.hostToken }, (jr) => {
        if (jr?.ok) {
          state.data = jr.state;
          renderAll();
        } else {
          localStorage.removeItem("jeop_host_code");
          localStorage.removeItem("jeop_host_token");
        }
      });
    }
  }

  // ---------- Viewer wiring (falls du app.js irgendwann auch dort nutzt) ----------
  if (state.role !== "host") {
    const codeFromUrl = new URLSearchParams(location.search).get("code");
    const codeInput = $("#codeInput");
    const btnJoin = $("#btnJoin");

    if (codeFromUrl && codeInput) codeInput.value = codeFromUrl;

    function join(code) {
      state.code = code;
      ui.roomPill && (ui.roomPill.textContent = `Room: ${state.code}`);
      socket.emit("room:join", { code: state.code, role: "viewer" }, (jr) => {
        if (!jr?.ok) return alert("Room nicht gefunden.");
        state.data = jr.state;
        renderAll();
      });
    }

    btnJoin?.addEventListener("click", () => {
      const code = (codeInput?.value || "").trim().toUpperCase();
      if (code) join(code);
    });

    if (codeFromUrl) join(codeFromUrl.toUpperCase());

    ui.btnClose?.addEventListener("click", () => ui.modal?.classList.remove("open"));
    ui.modal?.addEventListener("click", (e) => { if (e.target === ui.modal) ui.modal?.classList.remove("open"); });
  }

  // ---------- Realtime updates ----------
  socket.on("state:update", (next) => {
    state.data = next;
    renderAll();
  });

  socket.on("room:presence", (p) => {
    if (state.role === "host" && ui.viewerPill) ui.viewerPill.textContent = `Viewer: ${p.viewers ?? 0}`;
  });
};
