(() => {
  const state = {
    analysis: null,
    selections: {},
    pickStep: "a",
    pointA: null,
    pointB: null,
    connectId: null,
    layers: {
      raw: null,
      anomalies: [],
      preview: null,
      markerA: null,
      markerB: null,
      manualRoutes: [],
    },
  };

  const els = {
    form: document.getElementById("upload-form"),
    file: document.getElementById("file"),
    fileLabel: document.getElementById("file-label"),
    profile: document.getElementById("profile"),
    status: document.getElementById("status"),
    summary: document.getElementById("summary"),
    anomalies: document.getElementById("anomalies"),
    anomalyList: document.getElementById("anomaly-list"),
    applyBtn: document.getElementById("apply-btn"),
    exportFormat: document.getElementById("export-format"),
    health: document.getElementById("health"),
    analyzeBtn: document.getElementById("analyze-btn"),
    pickA: document.getElementById("pick-a"),
    pickB: document.getElementById("pick-b"),
    pickAVal: document.getElementById("pick-a-val"),
    pickBVal: document.getElementById("pick-b-val"),
    connectBtn: document.getElementById("connect-btn"),
    resetPicks: document.getElementById("reset-picks"),
    manualRoutes: document.getElementById("manual-routes"),
  };

  const map = L.map("map", { zoomControl: true }).setView([55.75, 37.62], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(map);

  function setStatus(text, isError = false) {
    els.status.textContent = text || "";
    els.status.classList.toggle("error", Boolean(isError));
  }

  function findOption(optionId) {
    return state.analysis?.options?.find((o) => o.id === optionId);
  }

  function pointLabel(idx) {
    const p = state.analysis?.track?.points?.[idx];
    if (!p) return "не выбрана";
    return `#${idx} · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  }

  function updatePickUI() {
    els.pickAVal.textContent = state.pointA == null ? "не выбрана" : pointLabel(state.pointA);
    els.pickBVal.textContent = state.pointB == null ? "не выбрана" : pointLabel(state.pointB);
    els.pickA.classList.toggle("active", state.pickStep === "a");
    els.pickB.classList.toggle("active", state.pickStep === "b");
    const ready = state.pointA != null && state.pointB != null && state.pointA !== state.pointB;
    els.connectBtn.disabled = !ready || !state.analysis;
    els.resetPicks.disabled = state.pointA == null && state.pointB == null;
  }

  async function checkHealth() {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      els.health.hidden = false;
      if (data.mapbox_configured) {
        els.health.textContent = "Mapbox: подключён";
        els.health.className = "health ok";
      } else {
        els.health.textContent = "Mapbox: нет токена (локальные фиксы)";
        els.health.className = "health warn";
      }
    } catch {
      els.health.hidden = false;
      els.health.textContent = "API недоступен";
      els.health.className = "health warn";
    }
  }

  function clearManualOverlays() {
    if (state.layers.markerA) {
      map.removeLayer(state.layers.markerA);
      state.layers.markerA = null;
    }
    if (state.layers.markerB) {
      map.removeLayer(state.layers.markerB);
      state.layers.markerB = null;
    }
    state.layers.manualRoutes.forEach((layer) => map.removeLayer(layer));
    state.layers.manualRoutes = [];
  }

  function clearLayers() {
    if (state.layers.raw) {
      map.removeLayer(state.layers.raw);
      state.layers.raw = null;
    }
    state.layers.anomalies.forEach((layer) => map.removeLayer(layer));
    state.layers.anomalies = [];
    if (state.layers.preview) {
      map.removeLayer(state.layers.preview);
      state.layers.preview = null;
    }
    clearManualOverlays();
  }

  function toLatLngs(points) {
    return points.map((p) => [p.lat, p.lon]);
  }

  function drawPickMarkers() {
    if (state.layers.markerA) {
      map.removeLayer(state.layers.markerA);
      state.layers.markerA = null;
    }
    if (state.layers.markerB) {
      map.removeLayer(state.layers.markerB);
      state.layers.markerB = null;
    }
    const pts = state.analysis?.track?.points;
    if (!pts) return;
    if (state.pointA != null) {
      const p = pts[state.pointA];
      state.layers.markerA = L.circleMarker([p.lat, p.lon], {
        radius: 8,
        color: "#1a1408",
        weight: 2,
        fillColor: "#e06b5c",
        fillOpacity: 1,
      })
        .bindTooltip("A", { permanent: true, direction: "top" })
        .addTo(map);
    }
    if (state.pointB != null) {
      const p = pts[state.pointB];
      state.layers.markerB = L.circleMarker([p.lat, p.lon], {
        radius: 8,
        color: "#1a1408",
        weight: 2,
        fillColor: "#7ec8b8",
        fillOpacity: 1,
      })
        .bindTooltip("B", { permanent: true, direction: "top" })
        .addTo(map);
    }
  }

  function drawTrack(analysis) {
    clearLayers();
    const latlngs = toLatLngs(analysis.track.points);
    state.layers.raw = L.polyline(latlngs, {
      color: "#7ec8b8",
      weight: 4,
      opacity: 0.9,
    }).addTo(map);

    analysis.anomalies.forEach((a) => {
      const slice = analysis.track.points.slice(a.start_index, a.end_index + 1);
      if (slice.length < 2) return;
      const layer = L.polyline(toLatLngs(slice), {
        color: "#e06b5c",
        weight: 6,
        opacity: 0.95,
      }).addTo(map);
      layer.bindPopup(`<strong>${a.type}</strong><br>${a.message}`);
      state.layers.anomalies.push(layer);
    });

    map.fitBounds(state.layers.raw.getBounds(), { padding: [28, 28] });
    drawPickMarkers();
  }

  function previewSelection() {
    if (state.layers.preview) {
      map.removeLayer(state.layers.preview);
      state.layers.preview = null;
    }
    if (!state.analysis) return;

    const parts = [];
    for (const optionId of Object.values(state.selections)) {
      const opt = findOption(optionId);
      if (!opt || opt.method === "keep" || !opt.geometry?.length) continue;
      parts.push(...opt.geometry);
    }
    if (!parts.length) return;
    state.layers.preview = L.polyline(toLatLngs(parts), {
      color: "#f0c35a",
      weight: 5,
      opacity: 0.95,
      dashArray: "8 6",
    }).addTo(map);
  }

  function nearestPointIndex(latlng) {
    const pts = state.analysis.track.points;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = map.distance(latlng, L.latLng(pts[i].lat, pts[i].lon));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  function setPoint(idx) {
    if (state.pickStep === "a" || state.pointA == null) {
      state.pointA = idx;
      state.pickStep = "b";
    } else {
      state.pointB = idx;
      state.pickStep = "a";
    }
    drawPickMarkers();
    updatePickUI();
  }

  function useGapAsAB(anomaly) {
    state.pointA = anomaly.start_index;
    state.pointB = anomaly.end_index;
    state.pickStep = "a";
    drawPickMarkers();
    updatePickUI();
    setStatus("Разрыв подставлен в A/B. Можно построить соединение по дорогам.");
  }

  /** If manual connect overlaps an auto gap fix, switch that gap to "keep". */
  function suppressOverlappingAutoFixes(fromIdx, toIdx) {
    (state.analysis.anomalies || []).forEach((anomaly) => {
      const overlaps = anomaly.start_index <= toIdx && anomaly.end_index >= fromIdx;
      if (!overlaps) return;
      const keep = state.analysis.options.find(
        (o) => o.anomaly_id === anomaly.id && o.method === "keep"
      );
      if (keep) {
        state.selections[anomaly.id] = keep.id;
        const radio = document.querySelector(
          `input[name="anomaly-${anomaly.id}"][value="${keep.id}"]`
        );
        if (radio) radio.checked = true;
      } else {
        delete state.selections[anomaly.id];
      }
    });
  }

  function renderManualRoutes(connectId, options) {
    els.manualRoutes.hidden = false;
    els.manualRoutes.innerHTML = "<h3>Варианты ручного соединения</h3>";
    state.layers.manualRoutes.forEach((layer) => map.removeLayer(layer));
    state.layers.manualRoutes = [];

    const preferred =
      options.find((o) => o.method === "directions_fill") || options[0];
    if (preferred) {
      state.selections[connectId] = preferred.id;
      suppressOverlappingAutoFixes(preferred.replaces_from, preferred.replaces_to);
    }

    options.forEach((opt, idx) => {
      if (opt.geometry?.length >= 2 && opt.method === "directions_fill") {
        const layer = L.polyline(toLatLngs(opt.geometry), {
          color: idx === 0 ? "#f0c35a" : "#7aa2ff",
          weight: 4,
          opacity: 0.85,
        }).addTo(map);
        state.layers.manualRoutes.push(layer);
      }

      const row = document.createElement("label");
      row.className = "option";
      row.innerHTML = `
        <input type="radio" name="manual-connect" value="${opt.id}" ${
          state.selections[connectId] === opt.id ? "checked" : ""
        } />
        <div>
          <strong>${opt.label}</strong>
          <small>${opt.description}</small>
        </div>
      `;
      row.querySelector("input").addEventListener("change", () => {
        state.selections[connectId] = opt.id;
        suppressOverlappingAutoFixes(opt.replaces_from, opt.replaces_to);
        previewSelection();
      });
      els.manualRoutes.appendChild(row);
    });

    previewSelection();
  }

  function renderSummary(analysis) {
    const s = analysis.summary || {};
    els.summary.hidden = false;
    els.summary.innerHTML = `
      <div><strong>${s.point_count ?? analysis.track.points.length}</strong><span>точек</span></div>
      <div><strong>${Math.round(s.length_m || 0)}</strong><span>метров</span></div>
      <div><strong>${s.anomaly_count ?? analysis.anomalies.length}</strong><span>аномалий</span></div>
    `;
  }

  function renderAnomalies(analysis) {
    els.anomalies.hidden = false;
    els.anomalyList.innerHTML = "";
    state.selections = {};
    state.connectId = null;
    els.manualRoutes.hidden = true;
    els.manualRoutes.innerHTML = "";

    if (!analysis.anomalies.length) {
      els.anomalyList.innerHTML = `<p class="lede">Аномалий не найдено. Можно соединить участок вручную ниже или скачать трек как есть.</p>`;
      els.applyBtn.disabled = false;
      return;
    }

    analysis.anomalies.forEach((anomaly, idx) => {
      const options = analysis.options.filter((o) => o.anomaly_id === anomaly.id);
      const preferred =
        options.find((o) => o.method === "map_match" || o.method === "directions_fill") ||
        options.find((o) => o.method === "interpolate") ||
        options[0];
      if (preferred) state.selections[anomaly.id] = preferred.id;

      const card = document.createElement("article");
      card.className = "anomaly-card";
      card.style.animationDelay = `${idx * 40}ms`;
      card.innerHTML = `
        <h3>${anomaly.type.toUpperCase()} · severity ${(anomaly.severity * 100).toFixed(0)}%</h3>
        <p>${anomaly.message} · точки ${anomaly.start_index}–${anomaly.end_index}</p>
        <div class="options"></div>
      `;
      const box = card.querySelector(".options");
      options.forEach((opt) => {
        const row = document.createElement("label");
        row.className = "option";
        const conf =
          opt.confidence != null ? ` · conf ${(opt.confidence * 100).toFixed(0)}%` : "";
        row.innerHTML = `
          <input type="radio" name="anomaly-${anomaly.id}" value="${opt.id}" ${
            state.selections[anomaly.id] === opt.id ? "checked" : ""
          } />
          <div>
            <strong>${opt.label}</strong>
            <small>${opt.description}${conf}</small>
          </div>
        `;
        row.querySelector("input").addEventListener("change", () => {
          state.selections[anomaly.id] = opt.id;
          previewSelection();
        });
        box.appendChild(row);
      });

      if (anomaly.type === "gap") {
        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "ghost use-gap-btn";
        useBtn.textContent = "Вариант: соединить этот разрыв вручную (A→B)";
        useBtn.addEventListener("click", () => useGapAsAB(anomaly));
        card.appendChild(useBtn);
      }

      els.anomalyList.appendChild(card);
    });

    els.applyBtn.disabled = false;
    previewSelection();
  }

  map.on("click", (e) => {
    if (!state.analysis) return;
    setPoint(nearestPointIndex(e.latlng));
  });

  els.pickA.addEventListener("click", () => {
    state.pickStep = "a";
    updatePickUI();
  });
  els.pickB.addEventListener("click", () => {
    state.pickStep = "b";
    updatePickUI();
  });

  els.resetPicks.addEventListener("click", () => {
    if (state.connectId) delete state.selections[state.connectId];
    state.pointA = null;
    state.pointB = null;
    state.pickStep = "a";
    state.connectId = null;
    els.manualRoutes.hidden = true;
    els.manualRoutes.innerHTML = "";
    state.layers.manualRoutes.forEach((layer) => map.removeLayer(layer));
    state.layers.manualRoutes = [];
    drawPickMarkers();
    updatePickUI();
    previewSelection();
  });

  els.connectBtn.addEventListener("click", async () => {
    if (!state.analysis || state.pointA == null || state.pointB == null) return;
    els.connectBtn.disabled = true;
    setStatus("Строим вариант соединения A→B…");
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          track_id: state.analysis.track_id,
          start_index: state.pointA,
          end_index: state.pointB,
          profile: els.profile.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail));
      }
      if (state.connectId) delete state.selections[state.connectId];
      state.connectId = data.connect_id;
      // merge options into analysis for apply/preview lookup
      const known = new Set(state.analysis.options.map((o) => o.id));
      data.options.forEach((o) => {
        if (!known.has(o.id)) state.analysis.options.push(o);
      });
      renderManualRoutes(data.connect_id, data.options);
      setStatus(data.message || "Вариант соединения добавлен. Выберите маршрут и нажмите «Применить».");
    } catch (err) {
      setStatus(err.message || String(err), true);
    } finally {
      updatePickUI();
    }
  });

  els.file.addEventListener("change", () => {
    const name = els.file.files?.[0]?.name;
    els.fileLabel.textContent = name || "Выберите файл или перетащите сюда";
  });

  const drop = document.querySelector(".file-drop");
  ["dragenter", "dragover"].forEach((evt) => {
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.remove("drag");
    });
  });
  drop.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    els.file.files = dt.files;
    els.fileLabel.textContent = file.name;
  });

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = els.file.files?.[0];
    if (!file) return;

    const body = new FormData();
    body.append("file", file);
    body.append("profile", els.profile.value);

    els.analyzeBtn.disabled = true;
    els.applyBtn.disabled = true;
    setStatus("Анализ трека…");

    try {
      const res = await fetch("/api/analyze", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Ошибка анализа");
      state.analysis = data;
      state.pointA = null;
      state.pointB = null;
      state.pickStep = "a";
      state.connectId = null;
      drawTrack(data);
      renderSummary(data);
      renderAnomalies(data);
      updatePickUI();
      setStatus(
        data.summary?.mapbox_configured
          ? "Готово. Выберите авто-варианты или дополнительно соедините разрыв вручную (A→B)."
          : "Готово без Mapbox: доступны локальные варианты. Добавьте MAPBOX_ACCESS_TOKEN."
      );
    } catch (err) {
      setStatus(err.message || String(err), true);
    } finally {
      els.analyzeBtn.disabled = false;
    }
  });

  els.applyBtn.addEventListener("click", async () => {
    if (!state.analysis) return;
    els.applyBtn.disabled = true;
    setStatus("Применяем исправления…");
    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          track_id: state.analysis.track_id,
          selections: state.selections,
          export_format: els.exportFormat.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Ошибка применения");
      window.location.href = data.download_path;
      setStatus(`Скачивание: ${data.point_count} точек`);
    } catch (err) {
      setStatus(err.message || String(err), true);
    } finally {
      els.applyBtn.disabled = false;
    }
  });

  updatePickUI();
  checkHealth();
})();
