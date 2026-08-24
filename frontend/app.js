(() => {
  const state = {
    analysis: null,
    selections: {},
    pickStep: "a",
    pointA: null,
    pointB: null,
    supplementId: null,
    focusedOptionId: null,
    layers: {
      raw: null,
      anomalies: [],
      previews: [],
      markerA: null,
      markerB: null,
      supplementRoutes: [],
      supplementSegment: null,
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
    supplementBtn: document.getElementById("supplement-btn"),
    resetPicks: document.getElementById("reset-picks"),
    supplementRoutes: document.getElementById("supplement-routes"),
    bulkActions: document.getElementById("bulk-actions"),
    allGapsRoadBtn: document.getElementById("all-gaps-road-btn"),
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
    els.supplementBtn.disabled = !ready || !state.analysis;
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

  function clearSupplementOverlays() {
    if (state.layers.markerA) {
      map.removeLayer(state.layers.markerA);
      state.layers.markerA = null;
    }
    if (state.layers.markerB) {
      map.removeLayer(state.layers.markerB);
      state.layers.markerB = null;
    }
    state.layers.supplementRoutes.forEach((layer) => map.removeLayer(layer));
    state.layers.supplementRoutes = [];
    if (state.layers.supplementSegment) {
      map.removeLayer(state.layers.supplementSegment);
      state.layers.supplementSegment = null;
    }
  }

  function clearLayers() {
    if (state.layers.raw) {
      map.removeLayer(state.layers.raw);
      state.layers.raw = null;
    }
    state.layers.anomalies.forEach((layer) => map.removeLayer(layer));
    state.layers.anomalies = [];
    clearPreviews();
    clearSupplementOverlays();
  }

  function clearPreviews() {
    state.layers.previews.forEach((layer) => map.removeLayer(layer));
    state.layers.previews = [];
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
    drawSupplementSegment();
  }

  function drawSupplementSegment() {
    if (state.layers.supplementSegment) {
      map.removeLayer(state.layers.supplementSegment);
      state.layers.supplementSegment = null;
    }
    if (state.pointA == null || state.pointB == null || !state.analysis) return;
    const pts = state.analysis.track.points;
    const lo = Math.min(state.pointA, state.pointB);
    const hi = Math.max(state.pointA, state.pointB);
    const slice = pts.slice(lo, hi + 1);
    if (slice.length < 2) return;
    state.layers.supplementSegment = L.polyline(toLatLngs(slice), {
      color: "#56e6a8",
      weight: 5,
      opacity: 0.85,
      dashArray: "6 8",
    })
      .bindPopup("Участок между якорями A и B (будет дополнен маршрутом)")
      .addTo(map);
  }

  function previewSelection(focusOptionId = null) {
    clearPreviews();
    if (!state.analysis) return;

    if (focusOptionId) state.focusedOptionId = focusOptionId;
    let focusLayer = null;

    for (const optionId of Object.values(state.selections)) {
      const opt = findOption(optionId);
      if (!opt || opt.method === "keep" || !opt.geometry?.length) continue;
      const isFocus = opt.id === state.focusedOptionId;
      const color =
        opt.method === "map_match"
          ? "#ff4fd8"
          : opt.method === "directions_fill" || opt.method === "supplement_fill"
            ? "#f0c35a"
            : opt.method === "supplement_interpolate"
              ? "#56e6a8"
              : "#9ad0ff";
      const layer = L.polyline(toLatLngs(opt.geometry), {
        color,
        weight: isFocus ? 7 : 4,
        opacity: isFocus ? 1 : 0.45,
        dashArray: opt.method === "interpolate" ? "6 8" : null,
      }).addTo(map);
      layer.bindTooltip(
        `${opt.label} · ${opt.geometry.length} точек` +
          (opt.confidence != null ? ` · conf ${(opt.confidence * 100).toFixed(0)}%` : ""),
        { sticky: true }
      );
      state.layers.previews.push(layer);
      if (isFocus) focusLayer = layer;
    }

    if (focusLayer && focusLayer.getBounds().isValid()) {
      map.fitBounds(focusLayer.getBounds(), { padding: [48, 48], maxZoom: 16 });
    }
  }

  function selectOption(anomalyId, optionId) {
    state.selections[anomalyId] = optionId;
    const opt = findOption(optionId);
    previewSelection(optionId);
    if (!opt) {
      setStatus("Вариант выбран, но геометрия не найдена.", true);
      return;
    }
    if (opt.method === "keep") {
      setStatus("Оставляем участок как в файле.");
      return;
    }
    const conf =
      opt.confidence != null ? `, уверенность ${(opt.confidence * 100).toFixed(0)}%` : "";
    setStatus(
      `На карте: ${opt.label} (${opt.geometry.length} точек${conf}). Mapbox считается при анализе, выбор только переключает готовый вариант.`
    );
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
    if (state.supplementId) delete state.selections[state.supplementId];
    state.supplementId = null;
    els.supplementRoutes.hidden = true;
    els.supplementRoutes.innerHTML = "";
    state.layers.supplementRoutes.forEach((layer) => map.removeLayer(layer));
    state.layers.supplementRoutes = [];
    drawPickMarkers();
    drawSupplementSegment();
    updatePickUI();
  }

  function useSupplementAnchors(aIdx, bIdx) {
    state.pointA = aIdx;
    state.pointB = bIdx;
    state.pickStep = "a";
    drawPickMarkers();
    drawSupplementSegment();
    updatePickUI();
    setStatus(`Якоря A (#${aIdx}) и B (#${bIdx}) — точки существующего трека. Постройте дополнение.`);
  }

  function useSupplementAfterDiscard(anomaly) {
    const n = state.analysis.track.points.length;
    const a = Math.max(0, anomaly.start_index - 1);
    const b = Math.min(n - 1, anomaly.end_index + 1);
    if (a >= b) {
      setStatus("Не удалось определить якоря до/после выброса.", true);
      return;
    }
    useSupplementAnchors(a, b);
    setStatus(
      `После «Удалить выброс»: якоря A (#${a}) и B (#${b}). Сначала примените удаление, затем дополнение — или дополните сразу.`
    );
  }

  /** If supplement overlaps an auto fix, switch that anomaly to "keep". */
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

  function renderSupplementRoutes(supplementId, options) {
    els.supplementRoutes.hidden = false;
    els.supplementRoutes.innerHTML = "<h3>Варианты дополнения</h3>";
    state.layers.supplementRoutes.forEach((layer) => map.removeLayer(layer));
    state.layers.supplementRoutes = [];

    const preferred =
      options.find((o) => o.method === "supplement_fill") || options[0];
    if (preferred) {
      state.selections[supplementId] = preferred.id;
      suppressOverlappingAutoFixes(preferred.replaces_from, preferred.replaces_to);
    }

    options.forEach((opt, idx) => {
      if (opt.geometry?.length >= 2 && opt.method === "supplement_fill") {
        const layer = L.polyline(toLatLngs(opt.geometry), {
          color: idx === 0 ? "#56e6a8" : "#7aa2ff",
          weight: 4,
          opacity: 0.85,
        }).addTo(map);
        state.layers.supplementRoutes.push(layer);
      }

      const row = document.createElement("label");
      row.className = "option";
      row.innerHTML = `
        <input type="radio" name="supplement-opt" value="${opt.id}" ${
          state.selections[supplementId] === opt.id ? "checked" : ""
        } />
        <div>
          <strong>${opt.label}</strong>
          <small>${opt.description}</small>
        </div>
      `;
      row.querySelector("input").addEventListener("change", () => {
        state.selections[supplementId] = opt.id;
        suppressOverlappingAutoFixes(opt.replaces_from, opt.replaces_to);
        selectOption(supplementId, opt.id);
      });
      els.supplementRoutes.appendChild(row);
    });

    if (preferred) selectOption(supplementId, preferred.id);
  }

  function findDirectionsOption(anomalyId, profileHint) {
    const options = state.analysis.options.filter(
      (o) => o.anomaly_id === anomalyId && o.method === "directions_fill"
    );
    if (!options.length) return null;
    if (profileHint && profileHint !== "mixed") {
      return options.find((o) => o.profile === profileHint) || options[0];
    }
    return (
      options.find((o) => o.profile === "driving") ||
      options.find((o) => o.profile === "cycling") ||
      options.find((o) => o.profile === "walking") ||
      options[0]
    );
  }

  function applyRoadRouteForAllGaps() {
    if (!state.analysis) return;
    const gaps = state.analysis.anomalies.filter((a) => a.type === "gap");
    if (!gaps.length) {
      setStatus("Разрывов (gap) не найдено.", true);
      return;
    }

    const profile = els.profile.value;
    let applied = 0;
    let missing = 0;
    let lastOptId = null;

    for (const gap of gaps) {
      const opt = findDirectionsOption(gap.id, profile);
      if (!opt) {
        missing++;
        continue;
      }
      state.selections[gap.id] = opt.id;
      lastOptId = opt.id;
      const radio = document.querySelector(
        `input[name="anomaly-${gap.id}"][value="${opt.id}"]`
      );
      if (radio) radio.checked = true;
      applied++;
    }

    if (state.supplementId) {
      delete state.selections[state.supplementId];
      state.supplementId = null;
      els.supplementRoutes.hidden = true;
      els.supplementRoutes.innerHTML = "";
    }

    if (lastOptId) previewSelection(lastOptId);
    else previewSelection();

    const profileLabel = profile === "mixed" ? "driving (mixed)" : profile;
    if (!applied) {
      setStatus(
        "Для разрывов нет маршрутов Mapbox. Проверьте токен или выберите другой профиль.",
        true
      );
      return;
    }
    setStatus(
      `Для ${applied} разрыв(ов) выбран «Маршрут по карте» (${profileLabel})${
        missing ? `. Без маршрута: ${missing}` : ""
      }. Нажмите «Применить и скачать».`
    );
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
    state.supplementId = null;
    els.supplementRoutes.hidden = true;
    els.supplementRoutes.innerHTML = "";

    if (!analysis.anomalies.length) {
      els.anomalyList.innerHTML = `<p class="lede">Аномалий не найдено. Можно соединить участок вручную ниже или скачать трек как есть.</p>`;
      els.bulkActions.hidden = true;
      els.applyBtn.disabled = false;
      return;
    }

    const gapCount = analysis.anomalies.filter((a) => a.type === "gap").length;
    els.bulkActions.hidden = gapCount === 0;
    els.allGapsRoadBtn.disabled = gapCount === 0;

    analysis.anomalies.forEach((anomaly, idx) => {
      const options = analysis.options.filter((o) => o.anomaly_id === anomaly.id);
      const preferred =
        options.find((o) => o.method === "directions_fill") ||
        options.find((o) => o.method === "map_match" && (o.confidence == null || o.confidence >= 0.1)) ||
        options.find((o) => o.method === "map_match") ||
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
          selectOption(anomaly.id, opt.id);
        });
        box.appendChild(row);
      });

      if (anomaly.type === "gap") {
        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "ghost use-gap-btn";
        useBtn.textContent = "Якоря A/B этого разрыва";
        useBtn.addEventListener("click", () =>
          useSupplementAnchors(anomaly.start_index, anomaly.end_index)
        );
        card.appendChild(useBtn);
      }

      if (anomaly.type === "spike" || anomaly.type === "noise" || anomaly.type === "jump") {
        const supBtn = document.createElement("button");
        supBtn.type = "button";
        supBtn.className = "ghost use-gap-btn";
        supBtn.textContent = "Дополнить после удаления выброса";
        supBtn.addEventListener("click", () => useSupplementAfterDiscard(anomaly));
        card.appendChild(supBtn);
      }

      els.anomalyList.appendChild(card);
    });

    els.applyBtn.disabled = false;
    const firstId = Object.values(state.selections)[0];
    if (firstId) previewSelection(firstId);
    else previewSelection();
  }

  els.allGapsRoadBtn.addEventListener("click", applyRoadRouteForAllGaps);

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
    if (state.supplementId) delete state.selections[state.supplementId];
    state.pointA = null;
    state.pointB = null;
    state.pickStep = "a";
    state.supplementId = null;
    els.supplementRoutes.hidden = true;
    els.supplementRoutes.innerHTML = "";
    state.layers.supplementRoutes.forEach((layer) => map.removeLayer(layer));
    state.layers.supplementRoutes = [];
    drawPickMarkers();
    drawSupplementSegment();
    updatePickUI();
    previewSelection();
  });

  els.supplementBtn.addEventListener("click", async () => {
    if (!state.analysis || state.pointA == null || state.pointB == null) return;
    els.supplementBtn.disabled = true;
    setStatus("Строим дополнение трека между якорями A и B…");
    try {
      const res = await fetch("/api/supplement", {
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
      if (state.supplementId) delete state.selections[state.supplementId];
      state.supplementId = data.supplement_id;
      const known = new Set(state.analysis.options.map((o) => o.id));
      data.options.forEach((o) => {
        if (!known.has(o.id)) state.analysis.options.push(o);
      });
      renderSupplementRoutes(data.supplement_id, data.options);
      setStatus(data.message || "Выберите вариант дополнения и нажмите «Применить».");
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
      state.supplementId = null;
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

  function buildApplySelections() {
    // Supplement A→B: apply only that variant (anchors kept on track).
    if (state.supplementId && state.selections[state.supplementId]) {
      return { [state.supplementId]: state.selections[state.supplementId] };
    }
    const out = {};
    for (const [anomalyId, optionId] of Object.entries(state.selections)) {
      const opt = findOption(optionId);
      if (opt && opt.method !== "keep") out[anomalyId] = optionId;
    }
    return out;
  }

  els.applyBtn.addEventListener("click", async () => {
    if (!state.analysis) return;
    const selections = buildApplySelections();
    if (!Object.keys(selections).length) {
      setStatus("Выберите вариант исправления (не «Оставить как есть»).", true);
      return;
    }
    els.applyBtn.disabled = true;
    setStatus("Применяем исправления…");
    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          track_id: state.analysis.track_id,
          selections,
          export_format: els.exportFormat.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Ошибка применения");

      if (data.track) {
        state.analysis.track = data.track;
        state.analysis.summary.point_count = data.point_count;
        state.pointA = null;
        state.pointB = null;
        state.supplementId = null;
        state.selections = {};
        els.supplementRoutes.hidden = true;
        els.supplementRoutes.innerHTML = "";
        drawTrack(state.analysis);
        renderSummary(state.analysis);
        updatePickUI();
      }

      const a = document.createElement("a");
      a.href = data.download_path;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setStatus(
        `Готово: ${data.point_count} точек (исходный трек + исправленный участок). Файл скачан.`
      );
    } catch (err) {
      setStatus(err.message || String(err), true);
    } finally {
      els.applyBtn.disabled = false;
    }
  });

  updatePickUI();
  checkHealth();
})();
