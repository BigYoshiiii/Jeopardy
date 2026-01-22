window.JEOPARDY_BOOT = function boot({ role }) {
  const $ = (s, el = document) => el.querySelector(s);

  const socket = io();

  const ui = {
    board: $("#board"),
    side: $("#side"),
    infoPill: $("#infoPill"),
    roomPill: $("#roomPill"),
    modal: $("#modal"),
    mCat: $("#mCat"),
    mVal: $("#mVal"),
    mQ: $("#mQ"),
    mA: $("#mA"),
    mABox: $("#mABox"),
    btnClose: $("#btnClose")
  };

  const state = {
    code: null,
    hostToken: null,
    role,
    mode: "edit", // host only: edit | play
    data: null
  };

  function setStatus(text) {
    const pill = $("#statusPill");
    if (pill) pill.textContent = text;
  }

  function setViewers(n) {
    const v = $("#viewerPill");
    if (v) v.textContent = `Viewer: ${n}`;
  }

  function renderAll() {
    if (!state.data) return;
    renderBoard();
    renderSide();
    renderModal();
    ui.infoPill.textContent = `${state.data.board.cols} Kategorien · ${state.data.board.rows} Reihen`;
  }

  function renderBoard() {
    const b = state.data.board;
    ui.board.innerHTML = "";
    ui.board.style.gridTemplateColumns = `repeat(${b.cols}, 1fr)`;
    ui.board.style.gridTemplateRows = `auto repeat(${b.rows}, 1fr)`;

    // categories header
    for (let c = 0; c < b.cols; c++) {
      const t = document.createElement("div");
      t.className = "tile cat";
      t.textContent = b.categories[c] ?? `Kategorie ${c + 1}`;
      if (state.role === "host" && state.mode === "edit") {
        t.title = "Kategorie bearbeiten";
        t.addEventListener("click", () => editCategory(c));
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
            t.title = "Frage bearbeiten";
            t.addEventListener("click", () => editClue(c, r));
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

    const scoresHtml = d.scores.map(t => `
      <div class="card" style="box-shadow:none;background:rgba(255,255,255,.03);border-radius:16px">
        <div class="bd">
          <div class="row" style="justify-content:space-between;align-items:center">
            <div style="font-weight:950">${escapeHtml(t.name)}</div>
            <div style="font-weight:950;font-size:20px">${t.score}</div>
          </div>
          ${state.role === "host" ? `
            <div class="row" style="margin-top:10px">
              <button class="good" data-score="+100" data-id="${t.id}">+100</button>
              <button class="bad" data-score="-100" data-id="${t.id}">-100</button>
              <button class="ghost" data-ren="${t.id}">Rename</button>
            </div>
          ` : ``}
        </div>
      </div>
    `).join("");

    let currentHtml = "";
    if (d.current.open) {
      const cl = d.board.clues[d.current.col][d.current.row];
      currentHtml = `
        <div class="pill">Aktive Frage</div>
        <div style="margin-top:10px;font-weight:950;font-size:16px">${escapeHtml(d.board.categories[d.current.col] || "—")}</div>
        <div class="muted" style="margin-top:6px;font-weight:900">${cl.value} Punkte</div>
        <div style="margin-top:10px" class="muted">Frage ist offen. ${d.current.showAnswer ? "Antwort ist sichtbar." : "Antwort noch versteckt."}</div>
      `;
    } else {
      currentHtml = `<div class="pill">Aktive Frage</div><div class="muted" style="margin-top:10px">Keine offene Frage.</div>`;
    }

    ui.side.innerHTML = `
      ${state.role === "host" ? `
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px">
          <span class="pill">Host Controls</span>
          <span class="pill muted">Mode: ${state.mode.toUpperCase()}</span>
        </div>
        <div class="row" style="margin-bottom:10px">
          <button class="ghost" id="modeEdit">Edit</button>
          <button class="ghost" id="modePlay">Play</button>
          <button class="ghost" id="closeQ">Close</button>
        </div>
      ` : `<div class="pill">Scores</div>`}

      <div class="grid" style="grid-template-columns:1fr;gap:10px">
        ${scoresHtml}
      </div>

      <div style="margin-top:14px" class="card" >
        <div class="bd">
          ${currentHtml}
        </div>
      </div>
    `;

    if (state.role === "host") {
      $("#modeEdit")?.addEventListener("click", () => { state.mode = "edit"; renderAll(); });
      $("#modePlay")?.addEventListener("click", () => { state.mode = "play"; renderAll(); });
      $("#closeQ")?.addEventListener("click", () => patch({ type: "close" }));

      ui.side.querySelectorAll("button[data-score]").forEach(btn => {
        btn.addEventListener("click", () => {
          const teamId = btn.getAttribute("data-id");
          const delta = Number(btn.getAttribute("data-score")) || 0;
          patch({ type: "scoreDelta", teamId, delta });
        });
      });

      ui.side.querySelectorAll("button[data-ren]").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-ren");
          const name = prompt("Team-Name:", d.scores.find(x => x.id === id)?.name ?? "");
          if (name == null) return;
          const next = d.scores.map(x => x.id === id ? { ...x, name: name.trim() || x.name } : x);
          patch({ type: "scoreSet", scores: next });
        });
      });
    }
  }

  function renderModal() {
    const d = state.data;
    if (!d) return;

    if (!d.current.open) {
      ui.modal.classList.remove("open");
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

    // Host extra controls inside modal
    if (state.role === "host") {
      injectHostModalControls(cl.value ?? 0, col, row);
    } else {
      removeHostModalControls();
    }
  }

  function injectHostModalControls(value, col, row) {
    // If already injected, do nothing
    if ($("#hostModalControls")) return;

    const dhdRow = ui.modal.querySelector(".dhd .row:last-child");
    const btnReveal = document.createElement("button");
    btnReveal.className = "ghost";
    btnReveal.id = "hostModalControls";
    btnReveal.textContent = "Antwort zeigen";
    btnReveal.addEventListener("click", () => patch({ type: "reveal" }));

    const btnUsed = document.createElement("button");
    btnUsed.className = "primary";
    btnUsed.textContent = "Als benutzt";
    btnUsed.addEventListener("click", () => patch({ type: "markUsed", col, row, used: true }));

    dhdRow.prepend(btnUsed);
    dhdRow.prepend(btnReveal);

    // Wire up host.html modal buttons if present
    $("#btnReveal")?.addEventListener("click", () => patch({ type: "reveal" }));
    $("#btnUsed")?.addEventListener("click", () => patch({ type: "markUsed", col, row, used: true }));
    $("#btnRight")?.addEventListener("click", () => {
      const teamId = state.data.scores[0]?.id; // simple MVP: Team 1 by default
      if (!teamId) return;
      patch({ type: "scoreDelta", teamId, delta: value });
    });
    $("#btnWrong")?.addEventListener("click", () => {
      const teamId = state.data.scores[0]?.id;
      if (!teamId) return;
      patch({ type: "scoreDelta", teamId, delta: -value });
    });
  }

  function removeHostModalControls() {
    const x = $("#hostModalControls");
    if (x) {
      // remove the reveal button only; keep whatever else
      x.remove();
    }
  }

  function editCategory(col) {
    const cur = state.data.board.categories[col] ?? "";
    const name = prompt(`Kategorie ${col + 1} Name:`, cur);
    if (name == null) return;
    patch({ type: "editCategory", col, name });
  }

  function editClue(col, row) {
    const cl = state.data.board.clues[col][row];
    const q = prompt("Frage:", cl.q ?? "") ?? cl.q;
    if (q == null) return;
    const a = prompt("Antwort:", cl.a ?? "") ?? cl.a;
    if (a == null) return;
    const vStr = prompt("Punkte:", String(cl.value ?? 0));
    const value = Number(vStr);
    patch({ type: "editClue", col, row, q, a, value: isFinite(value) ? value : (cl.value ?? 0) });
  }

  function patch(patchObj) {
    if (state.role !== "host") return;
    socket.emit("state:patch", { code: state.code, hostToken: state.hostToken, patch: patchObj }, (res) => {
      if (!res?.ok) alert(`Patch blocked: ${res?.error || "unknown"}`);
    });
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // Shared modal close
  ui.btnClose?.addEventListener("click", () => {
    if (state.role === "host") patch({ type: "close" });
    else ui.modal.classList.remove("open");
  });
  ui.modal?.addEventListener("click", (e) => {
    if (e.target === ui.modal) ui.btnClose?.click();
  });

  // HOST wiring
  if (role === "host") {
    $("#btnCreate")?.addEventListener("click", () => {
      socket.emit("room:create", null, (res) => {
        if (!res?.ok) return alert("Room erstellen ging nicht.");
        state.code = res.code;
        state.hostToken = res.hostToken;
        state.data = res.state;
        ui.roomPill.textContent = `Room: ${state.code}`;

        // store token locally for refresh
        localStorage.setItem("jeop_host_code", state.code);
        localStorage.setItem("jeop_host_token", state.hostToken);

        socket.emit("room:join", { code: state.code, role: "host", hostToken: state.hostToken }, (jr) => {
          if (!jr?.ok) return alert("Join failed.");
          state.data = jr.state;
          renderAll();
        });
      });
    });

    $("#btnCopy")?.addEventListener("click", async () => {
      if (!state.code) return;
      const url = `${location.origin}/view.html?code=${state.code}`;
      try {
        await navigator.clipboard.writeText(url);
        alert("Viewer-Link kopiert.");
      } catch {
        prompt("Copy das hier:", url);
      }
    });

    $("#btnResize")?.addEventListener("click", () => {
      if (!state.data) return;
      const cols = Number(prompt("Kategorien (2-10):", String(state.data.board.cols)));
      if (!isFinite(cols)) return;
      const rows = Number(prompt("Reihen (2-10):", String(state.data.board.rows)));
      if (!isFinite(rows)) return;
      patch({ type: "resize", cols, rows });
    });

    $("#btnResetUsed")?.addEventListener("click", () => {
      if (confirm("Alle Felder wieder auf unbenutzt?")) patch({ type: "resetUsed" });
    });

    // auto reconnect host if refreshed
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
          // token invalid or room gone
          localStorage.removeItem("jeop_host_code");
          localStorage.removeItem("jeop_host_token");
        }
      });
    }
  }

  // VIEWER wiring
  if (role === "viewer") {
    const codeFromUrl = new URLSearchParams(location.search).get("code");
    if (codeFromUrl) $("#codeInput").value = codeFromUrl;

    $("#btnJoin")?.addEventListener("click", () => {
      const code = ($("#codeInput").value || "").trim().toUpperCase();
      if (!code) return;
      joinViewer(code);
    });

    if (codeFromUrl) joinViewer(codeFromUrl.toUpperCase());

    function joinViewer(code) {
      state.code = code;
      ui.roomPill.textContent = `Room: ${state.code}`;
      setStatus("Verbinden...");
      socket.emit("room:join", { code: state.code, role: "viewer" }, (jr) => {
        if (!jr?.ok) {
          setStatus("Room nicht gefunden");
          return alert("Room nicht gefunden.");
        }
        state.data = jr.state;
        setStatus("Live");
        renderAll();
      });
    }
  }

  // Realtime updates
  socket.on("state:update", (next) => {
    state.data = next;
    renderAll();
  });

  socket.on("room:presence", (p) => {
    if (state.role === "host") setViewers(p.viewers ?? 0);
  });
};
