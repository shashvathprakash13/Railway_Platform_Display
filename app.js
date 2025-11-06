(function () {
  "use strict";

  // Utilities
  const pad2 = (n) => String(n).padStart(2, "0");
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const nowMs = () => Date.now();

  function toMinutes(hhmm) {
    if (typeof hhmm === "number") return hhmm;
    const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
    return h * 60 + m;
  }
  function toHHMM(minutes) {
    const m = ((minutes % (24 * 60)) + (24 * 60)) % (24 * 60);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${pad2(h)}:${pad2(mm)}`;
  }

  // Core data model
  const Status = {
    ON_TIME: "ON_TIME",
    DELAYED: "DELAYED",
    BOARDING: "BOARDING",
    DEPARTED: "DEPARTED",
    ARRIVED: "ARRIVED",
    CANCELLED: "CANCELLED",
  };

  const StorageKeys = {
    TRAINS: "rds.trains",
    SETTINGS: "rds.settings",
  };

  /**
   * Train object structure
   * id: string
   * trainNo: string
   * from: string
   * to: string
   * arrive: number (minutes since midnight)
   * depart: number (minutes since midnight)
   * delayMin: number
   * status: Status
   * platform: number | null
   */

  const state = {
    trains: [],
    announcements: [],
    numPlatforms: 6,
    sim: {
      virtualMinutes: 8 * 60, // 08:00
      autoAdvance: true,
      speed: 1,
      lastTick: nowMs(),
    },
    filterStatus: "all",
    editingId: null,
  };

  // Persistence
  function save() {
    localStorage.setItem(StorageKeys.TRAINS, JSON.stringify(state.trains));
    localStorage.setItem(
      StorageKeys.SETTINGS,
      JSON.stringify({
        numPlatforms: state.numPlatforms,
        sim: state.sim,
      })
    );
  }

  function load() {
    try {
      const t = JSON.parse(localStorage.getItem(StorageKeys.TRAINS) || "[]");
      const s = JSON.parse(localStorage.getItem(StorageKeys.SETTINGS) || "{}");
      if (Array.isArray(t)) state.trains = t;
      if (s && typeof s === "object") {
        if (typeof s.numPlatforms === "number") state.numPlatforms = s.numPlatforms;
        if (s.sim && typeof s.sim === "object") {
          state.sim.virtualMinutes = s.sim.virtualMinutes ?? state.sim.virtualMinutes;
          state.sim.autoAdvance = s.sim.autoAdvance ?? state.sim.autoAdvance;
          state.sim.speed = s.sim.speed ?? state.sim.speed;
        }
      }
    } catch (e) {
      console.warn("Failed to load saved state", e);
    }
  }

  // Scheduling & Assignment
  function timeWithDelay(train) {
    return {
      arrive: train.arrive + (train.status === Status.DELAYED ? train.delayMin : 0),
      depart: train.depart + (train.status === Status.DELAYED ? train.delayMin : 0),
    };
  }

  function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  function assignPlatforms(trains, numPlatforms) {
    // Greedy interval partitioning
    const sorted = [...trains].sort((a, b) => timeWithDelay(a).arrive - timeWithDelay(b).arrive);
    const platformEnd = new Array(numPlatforms).fill(-Infinity);
    for (const tr of sorted) {
      const twd = timeWithDelay(tr);
      let assigned = null;
      // Respect manual platform if no conflict
      if (typeof tr.platform === "number") {
        const p = clamp(tr.platform, 1, numPlatforms) - 1;
        if (!sorted.some((o) => o !== tr && o.platform === tr.platform && intervalsOverlap(timeWithDelay(o).arrive, timeWithDelay(o).depart, twd.arrive, twd.depart))) {
          assigned = p;
        }
      }
      if (assigned === null) {
        for (let i = 0; i < numPlatforms; i++) {
          if (!intervalsOverlap(platformEnd[i], platformEnd[i], twd.arrive, twd.arrive)) {
            // We track end availability differently: ensure no train occupies at time twd.arrive
          }
        }
        for (let i = 0; i < numPlatforms; i++) {
          if (platformEnd[i] <= twd.arrive) { assigned = i; break; }
        }
      }
      if (assigned === null) {
        // Choose platform that frees up earliest
        let best = 0; let bestEnd = platformEnd[0];
        for (let i = 1; i < numPlatforms; i++) {
          if (platformEnd[i] < bestEnd) { best = i; bestEnd = platformEnd[i]; }
        }
        assigned = best;
      }
      platformEnd[assigned] = Math.max(platformEnd[assigned], twd.depart);
      tr.assignedPlatform = assigned + 1;
    }
    return sorted;
  }

  function computeDerived() {
    // Update statuses based on virtual time
    const vm = state.sim.virtualMinutes;
    for (const tr of state.trains) {
      if (tr.status === Status.CANCELLED) continue;
      const { arrive, depart } = timeWithDelay(tr);
      if (vm >= depart + 5) tr.status = Status.DEPARTED;
      else if (vm >= depart - 5 && vm < depart + 5) tr.status = Status.BOARDING;
      else if (vm >= arrive && vm < depart - 5) tr.status = Status.ARRIVED; // at platform
      else if (tr.delayMin > 0) tr.status = Status.DELAYED;
      else tr.status = Status.ON_TIME;
    }
    // Platform assignment (creates assignedPlatform)
    assignPlatforms(state.trains, state.numPlatforms);
    // Sort for display by time
    state.trains.sort((a, b) => timeWithDelay(a).depart - timeWithDelay(b).depart);
  }

  // Announcements
  function announce(message) {
    const ts = toHHMM(state.sim.virtualMinutes);
    state.announcements.unshift(`[${ts}] ${message}`);
    state.announcements = state.announcements.slice(0, 6);
    renderAnnouncements();
  }

  // Rendering
  const el = {
    clock: document.getElementById("clock"),
    body: document.getElementById("display-body"),
    platformGrid: document.getElementById("platform-grid"),
    announcements: document.getElementById("announcements"),
    btnAdd: document.getElementById("btn-add-train"),
    btnSeed: document.getElementById("btn-seed"),
    btnClear: document.getElementById("btn-clear"),
    filter: document.getElementById("filter-status"),
    numPlatforms: document.getElementById("num-platforms"),
    autoAdvance: document.getElementById("auto-advance"),
    simSpeed: document.getElementById("sim-speed"),
    dialog: document.getElementById("train-dialog"),
    form: document.getElementById("train-form"),
    formSave: document.getElementById("train-save"),
    dialogTitle: document.getElementById("dialog-title"),
  };

  function renderClock() {
    el.clock.textContent = toHHMM(state.sim.virtualMinutes);
  }

  function renderTable() {
    const frag = document.createDocumentFragment();
    const filter = state.filterStatus;
    const rows = state.trains.filter((t) => filter === "all" || t.status === filter);
    for (const t of rows) {
      const tr = document.createElement("tr");
      const twd = timeWithDelay(t);

      const tdTime = document.createElement("td");
      tdTime.textContent = `${toHHMM(twd.arrive)} → ${toHHMM(twd.depart)}`;
      const tdTrain = document.createElement("td");
      tdTrain.textContent = t.trainNo;
      const tdFrom = document.createElement("td");
      tdFrom.textContent = t.from;
      const tdTo = document.createElement("td");
      tdTo.textContent = t.to;
      const tdPlat = document.createElement("td");
      tdPlat.textContent = (t.platform ?? t.assignedPlatform) ?? "-";
      const tdStatus = document.createElement("td");
      const st = document.createElement("span");
      st.className = `status ${t.status}`;
      st.textContent = t.status.replace("_", " ");
      tdStatus.appendChild(st);
      const tdActions = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "row-actions";
      const bEdit = document.createElement("button");
      bEdit.className = "btn icon-edit";
      bEdit.textContent = "Edit";
      bEdit.onclick = () => openEditTrain(t.id);
      const bDelay = document.createElement("button");
      bDelay.className = "btn icon-delay";
      bDelay.textContent = "+5m";
      bDelay.title = "Add 5 minutes delay";
      bDelay.onclick = () => delayTrain(t.id, 5);
      const bCancel = document.createElement("button");
      bCancel.className = "btn danger icon-cancel";
      bCancel.textContent = "Cancel";
      bCancel.onclick = () => cancelTrain(t.id);
      actions.append(bEdit, bDelay, bCancel);
      tdActions.appendChild(actions);

      tr.append(tdTime, tdTrain, tdFrom, tdTo, tdPlat, tdStatus, tdActions);
      frag.appendChild(tr);
    }
    el.body.replaceChildren(frag);
  }

  function renderPlatforms() {
    const frag = document.createDocumentFragment();
    for (let p = 1; p <= state.numPlatforms; p++) {
      const div = document.createElement("div");
      div.className = "platform";
      const title = document.createElement("div");
      title.className = "title";
      title.innerHTML = `<span>Platform ${p}</span><span class="meta"></span>`;
      const slots = document.createElement("div");
      slots.className = "slots";
      const onPlat = state.trains.filter((t) => (t.platform ?? t.assignedPlatform) === p);
      for (const t of onPlat) {
        const twd = timeWithDelay(t);
        const card = document.createElement("div");
        card.className = "slot";
        card.innerHTML = `<div class="train"><strong>${t.trainNo}</strong><span class="meta">${toHHMM(twd.arrive)}–${toHHMM(twd.depart)}</span></div><div class="meta">${t.from} → ${t.to} • <span class="status ${t.status}">${t.status.replace("_"," ")}</span></div>`;
        slots.appendChild(card);
      }
      div.append(title, slots);
      frag.appendChild(div);
    }
    el.platformGrid.replaceChildren(frag);
  }

  function renderAnnouncements() {
    const frag = document.createDocumentFragment();
    for (const a of state.announcements) {
      const li = document.createElement("li");
      li.textContent = a;
      frag.appendChild(li);
    }
    el.announcements.replaceChildren(frag);
  }

  function renderAll() {
    renderClock();
    computeDerived();
    renderTable();
    renderPlatforms();
    save();
  }

  // Actions
  function createId() { return Math.random().toString(36).slice(2, 10); }

  function addTrain(data) {
    const train = {
      id: createId(),
      trainNo: String(data.trainNo).trim(),
      from: String(data.from).trim(),
      to: String(data.to).trim(),
      arrive: toMinutes(data.arrive),
      depart: toMinutes(data.depart),
      delayMin: Number(data.delay || 0),
      status: data.status || Status.ON_TIME,
      platform: data.platform ? Number(data.platform) : null,
    };
    state.trains.push(train);
    announce(`Train ${train.trainNo} scheduled for platform ${(train.platform ?? "TBD")}.`);
    renderAll();
  }

  function updateTrain(id, updates) {
    const tr = state.trains.find((t) => t.id === id);
    if (!tr) return;
    Object.assign(tr, updates);
    announce(`Train ${tr.trainNo} updated.`);
    renderAll();
  }

  function delayTrain(id, minutes) {
    const tr = state.trains.find((t) => t.id === id);
    if (!tr) return;
    tr.delayMin = (tr.delayMin || 0) + minutes;
    tr.status = Status.DELAYED;
    announce(`Train ${tr.trainNo} delayed by ${minutes} minutes.`);
    renderAll();
  }

  function cancelTrain(id) {
    const tr = state.trains.find((t) => t.id === id);
    if (!tr) return;
    tr.status = Status.CANCELLED;
    announce(`Train ${tr.trainNo} has been cancelled.`);
    renderAll();
  }

  function clearAll() {
    state.trains = [];
    state.announcements = [];
    announce("All trains cleared.");
    renderAll();
  }

  function seed() {
    const base = toMinutes("08:00");
    state.trains = [
      { id: createId(), trainNo: "12001", from: "Central", to: "Harbor", arrive: base + 10, depart: base + 20, delayMin: 0, status: Status.ON_TIME, platform: 1 },
      { id: createId(), trainNo: "12002", from: "Uptown", to: "Lakeside", arrive: base + 15, depart: base + 30, delayMin: 0, status: Status.ON_TIME, platform: null },
      { id: createId(), trainNo: "12003", from: "Valley", to: "Central", arrive: base + 25, depart: base + 40, delayMin: 5, status: Status.DELAYED, platform: 2 },
      { id: createId(), trainNo: "12004", from: "Harbor", to: "Uptown", arrive: base + 35, depart: base + 50, delayMin: 0, status: Status.ON_TIME, platform: null },
      { id: createId(), trainNo: "12005", from: "Lakeside", to: "Valley", arrive: base + 55, depart: base + 70, delayMin: 0, status: Status.ON_TIME, platform: null },
    ];
    announce("Sample data seeded.");
    renderAll();
  }

  // Dialog helpers
  function openAddTrain() {
    state.editingId = null;
    el.dialogTitle.textContent = "Add Train";
    el.form.reset();
    el.dialog.showModal();
  }

  function openEditTrain(id) {
    state.editingId = id;
    const t = state.trains.find((x) => x.id === id);
    if (!t) return;
    el.dialogTitle.textContent = `Edit Train ${t.trainNo}`;
    el.form.trainNo.value = t.trainNo;
    el.form.from.value = t.from;
    el.form.to.value = t.to;
    el.form.arrive.value = toHHMM(t.arrive);
    el.form.depart.value = toHHMM(t.depart);
    el.form.platform.value = t.platform ?? "";
    el.form.status.value = t.status;
    el.form.delay.value = t.delayMin || 0;
    el.dialog.showModal();
  }

  // Event wiring
  function bindEvents() {
    el.btnAdd.addEventListener("click", openAddTrain);
    el.btnSeed.addEventListener("click", seed);
    el.btnClear.addEventListener("click", clearAll);
    el.filter.addEventListener("change", () => { state.filterStatus = el.filter.value; renderTable(); });
    el.numPlatforms.addEventListener("change", () => { state.numPlatforms = clamp(Number(el.numPlatforms.value || 1), 1, 20); renderAll(); });
    el.autoAdvance.addEventListener("change", () => { state.sim.autoAdvance = el.autoAdvance.checked; save(); });
    el.simSpeed.addEventListener("change", () => { state.sim.speed = Number(el.simSpeed.value || 1); save(); });

    el.form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const fd = new FormData(el.form);
      const data = Object.fromEntries(fd.entries());
      try {
        if (!data.trainNo || !data.from || !data.to || !data.arrive || !data.depart) {
          throw new Error("Please fill all required fields.");
        }
        if (state.editingId) {
          updateTrain(state.editingId, {
            trainNo: String(data.trainNo).trim(),
            from: String(data.from).trim(),
            to: String(data.to).trim(),
            arrive: toMinutes(data.arrive),
            depart: toMinutes(data.depart),
            platform: data.platform ? Number(data.platform) : null,
            status: data.status,
            delayMin: Number(data.delay || 0),
          });
        } else {
          addTrain(data);
        }
        el.dialog.close();
      } catch (e) {
        alert(e.message || String(e));
      }
    });
  }

  // Simulation loop
  function tick() {
    const now = nowMs();
    const dt = now - state.sim.lastTick;
    state.sim.lastTick = now;
    if (state.sim.autoAdvance) {
      const minutesToAdvance = (dt / 1000) * state.sim.speed; // seconds to minutes at 1:1 => 1 min per sec
      state.sim.virtualMinutes = (state.sim.virtualMinutes + minutesToAdvance) % (24 * 60);
      renderClock();
      computeDerived();
      renderTable();
      renderPlatforms();
      // Announce boarding and departures near events
      state.trains.forEach((t) => {
        const vm = state.sim.virtualMinutes;
        const { arrive, depart } = timeWithDelay(t);
        if (Math.abs(vm - (depart - 5)) < 0.1) announce(`Train ${t.trainNo} boarding at platform ${(t.platform ?? t.assignedPlatform)}.`);
        if (Math.abs(vm - depart) < 0.1) announce(`Train ${t.trainNo} departing from platform ${(t.platform ?? t.assignedPlatform)}.`);
      });
      save();
    }
    requestAnimationFrame(tick);
  }

  // Init
  function init() {
    load();
    // hydrate controls
    el.filter.value = state.filterStatus;
    el.numPlatforms.value = state.numPlatforms;
    el.autoAdvance.checked = state.sim.autoAdvance;
    el.simSpeed.value = String(state.sim.speed);
    bindEvents();
    renderAll();
    requestAnimationFrame(tick);
  }

  init();
})();

