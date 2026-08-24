(() => {
  const ROUTE_COLORS = ["#f0c35a", "#7aa2ff", "#e89a6a", "#c3e86b", "#c9a0ff", "#7ec8b8"];

  const state = {
    analysis: null,
    pickStep: "a", // a | b
    pointA: null,
    pointB: null,
    connectId: null,
    selectedOptionId: null,
    routeOptions: [],
    layers: {
      segments: [],
      gapHints: [],
      routes: [],
      markerA: null,
      markerB: null,
    },
  };

  const els = {
    form: document.getElementById("upload-form"),
    file: document.getElementById("file"),
    fileLabel: document.getElementById("file-label"),
    profile: document.getElementById("profile"),
    status: document.getElementById("status"),
    summary: document.getElementById("summary"),
    connectPanel: document.getElementById("connect-panel"),
    hintList: document.getElementById("hint-list"),
    routeList: document.getElementById("route-list"),
    routes: document.getElementById("routes"),
    applyBtn: document.getElementById("apply-btn"),
    connectBtn: document.getElementById("connect-btn"),
    resetPicks: document.getElementById("reset-picks"),
    exportFormat: document.getElementById("export-format"),
    health: document.getElementById("health"),
    analyzeBtn: document.getElementById("analyze-btn"),
    pickAVal: document.getElementById("pick-a-val"),
    pickBVal: document.getElementById("pick-b-val"),
    pickA: document.getElementById("pick-a"),
    pickB: document.getElementById("pick-b"),
    mapHint: document.getElementById("map-hint"),
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
    els.connectBtn.disabled = !ready;
    els.resetPicks.disabled = state.pointA == null && state.pointB == null;
    if (!state.analysis) {
      els.mapHint.textContent = "Загрузите трек, затем кликните точку A и точку B";
    } else if (state.pointA == null) {
      els.mapHint.textContent = "Шаг 1: кликните на трек — точка разрыва (A)";
    } else if (state.pointB == null) {
      els.mapHint.textContent = "Шаг 2: кликните точку соединения (B)";
    } else {
      els.mapHint.textContent = "A и B выбраны — постройте маршруты";
    }
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
        els.health.textContent = "Mapbox: нет токена";
        els.health.className = "health warn";
      }
    } catch {
      els.health.hidden = false;
      els.health.textContent = "API недоступен";
      els.health.className = "health warn";
    }
  }

  function clearLayerGroup(key) {
    (state.layers[key] || []).forEach((layer) => map.removeLayer(layer));
    state.layers[key] = [];
  }

  function clearMarkers() {
    if (state.layers.markerA) {
      map.removeLayer(state.layers.markerA);
      state.layers.markerA = null;
    }
    if (state.layers.markerB) {
      map.removeLayer(state.layers.markerB);
      state.layers.markerB = null;
    }
  }

  function toLatLngs(points) {
    return points.map((p) => [p.lat, p.lon]);
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

  function gapIndexSet() {
    const set = new Set();
    (state.analysis?.anomalies || []).forEach((a) => {
      if (a.type === "gap") set.add(a.start_index);
    });
    return set;
  }

  function drawTrack() {
    clearLayerGroup("segments");
    clearLayerGroup("gapHints");
    clearLayerGroup("routes");
    clearMarkers();

    const points = state.analysis.track.points;
    const gaps = gapIndexSet();
    let segment = [points[0]];

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (gaps.has(i)) {
        if (segment.length >= 2) {
          state.layers.segments.push(
            L.polyline(toLatLngs(segment), { color: "#7ec8b8", weight: 4, opacity: 0.95 }).addTo(map)
          );
        }
        // Do NOT draw a solid line across the gap — show dashed hint only
        state.layers.gapHints.push(
          L.polyline(
            [
              [a.lat, a.lon],
              [b.lat, b.lon],
            ],
            {
              color: "#e06b5c",
              weight: 3,
              opacity: 0.75,
              dashArray: "2 10",
            }
          )
            .bindPopup("Разрыв в файле (прямая только как подсказка, это не маршрут)")
            .addTo(map)
        );
        segment = [b];
      } else {
        segment.push(b);
      }
    }
    if (segment.length >= 2) {
      state.layers.segments.push(
        L.polyline(toLatLngs(segment), { color: "#7ec8b8", weight: 4, opacity: 0.95 }).addTo(map)
      );
    }

    const all = toLatLngs(points);
    if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [28, 28] });
    drawPickMarkers();
  }

  function drawPickMarkers() {
    clearMarkers();
    const pts = state.analysis?.track?.points;
    if (!pts) return;
    if (state.pointA != null) {
      const p = pts[state.pointA];
      state.layers.markerA = L.circleMarker([p.lat, p.lon], {
        radius: 9,
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
        radius: 9,
        color: "#1a1408",
        weight: 2,
        fillColor: "#7ec8b8",
        fillOpacity: 1,
      })
        .bindTooltip("B", { permanent: true, direction: "top" })
        .addTo(map);
    }
  }

  function renderSummary(analysis) {
    const s = analysis.summary || {};
    els.summary.hidden = false;
    els.summary.innerHTML = `
      <div><strong>${s.point_count ?? analysis.track.points.length}</strong><span>точек</span></div>
      <div><strong>${Math.round(s.length_m || 0)}</strong><span>метров</span></div>
      <div><strong>${s.anomaly_count ?? analysis.anomalies.length}</strong><span>подсказок</span></div>
    `;
  }

  function renderHints(analysis) {
    els.hintList.innerHTML = "";
    const gaps = (analysis.anomalies || []).filter((a) => a.type === "gap");
    if (!gaps.length) {
      els.hintList.innerHTML = `<p class="lede small">Авторазрывов не найдено — выберите A и B вручную на карте.</p>`;
      return;
    }
    const title = document.createElement("h3");
    title.className = "hints-title";
    title.textContent = "Подсказки разрывов";
    els.hintList.appendChild(title);

    gaps.forEach((a) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "hint-btn";
      row.textContent = `${a.message} → точки ${a.start_index}–${a.end_index}`;
      row.addEventListener("click", () => {
        state.pointA = a.start_index;
        state.pointB = a.end_index;
        state.pickStep = "a";
        state.selectedOptionId = null;
        state.routeOptions = [];
        els.routeList.hidden = true;
        els.applyBtn.disabled = true;
        clearLayerGroup("routes");
        drawPickMarkers();
        updatePickUI();
        setStatus("A/B подставлены из подсказки. Нажмите «Построить маршруты A→B».");
      });
      els.hintList.appendChild(row);
    });
  }

  function renderRoutes(options) {
    els.routeList.hidden = false;
    els.routes.innerHTML = "";
    clearLayerGroup("routes");
    state.routeOptions = options;

    const roadFirst = [...options].sort((a, b) => {
      const rank = (m) => (m === "directions_fill" ? 0 : 1);
      return rank(a.method) - rank(b.method);
    });

    roadFirst.forEach((opt, idx) => {
      const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
      if (opt.geometry?.length >= 2) {
        const layer = L.polyline(toLatLngs(opt.geometry), {
          color,
          weight: opt.method === "interpolate" ? 3 : 5,
          opacity: 0.35,
          dashArray: opt.method === "interpolate" ? "6 8" : null,
        }).addTo(map);
        layer.on("click", () => selectOption(opt.id));
        state.layers.routes.push(layer);
        opt._layer = layer;
        opt._color = color;
      }

      const row = document.createElement("label");
      row.className = "option route-option";
      row.innerHTML = `
        <input type="radio" name="route-opt" value="${opt.id}" />
        <div>
          <strong><i class="swatch" style="background:${color}"></i> ${opt.label}</strong>
          <small>${opt.description}</small>
        </div>
      `;
      row.querySelector("input").addEventListener("change", () => selectOption(opt.id));
      els.routes.appendChild(row);
    });

    const preferred = roadFirst.find((o) => o.method === "directions_fill") || roadFirst[0];
    if (preferred) selectOption(preferred.id);
  }

  function selectOption(optionId) {
    state.selectedOptionId = optionId;
    els.applyBtn.disabled = !optionId;
    els.routes.querySelectorAll('input[name="route-opt"]').forEach((input) => {
      input.checked = input.value === optionId;
    });
    state.routeOptions.forEach((opt) => {
      if (!opt._layer) return;
      const selected = opt.id === optionId;
      opt._layer.setStyle({
        opacity: selected ? 0.95 : 0.25,
        weight: selected ? 6 : opt.method === "interpolate" ? 3 : 4,
      });
      if (selected) opt._layer.bringToFront();
    });
  }

  function setPoint(idx) {
    if (state.pickStep === "a" || state.pointA == null) {
      state.pointA = idx;
      state.pickStep = "b";
    } else {
      state.pointB = idx;
      state.pickStep = "a";
    }
    state.selectedOptionId = null;
    state.routeOptions = [];
    els.routeList.hidden = true;
    els.applyBtn.disabled = true;
    clearLayerGroup("routes");
    drawPickMarkers();
    updatePickUI();
  }

  map.on("click", (e) => {
    if (!state.analysis) return;
    const idx = nearestPointIndex(e.latlng);
    setPoint(idx);
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
    state.pointA = null;
    state.pointB = null;
    state.pickStep = "a";
    state.selectedOptionId = null;
    state.routeOptions = [];
    els.routeList.hidden = true;
    els.applyBtn.disabled = true;
    clearLayerGroup("routes");
    clearMarkers();
    updatePickUI();
  });

  els.connectBtn.addEventListener("click", async () => {
    if (!state.analysis || state.pointA == null || state.pointB == null) return;
    els.connectBtn.disabled = true;
    setStatus("Строим маршруты Mapbox между A и B…");
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
      if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail));
      state.connectId = data.connect_id;
      renderRoutes(data.options);
      setStatus(data.message || "Выберите маршрут (жёлтый/цветной — по дорогам, пунктир — прямая).");
      const bounds = [];
      data.options.forEach((o) => o.geometry?.forEach((p) => bounds.push([p.lat, p.lon])));
      if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });
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
    setStatus("Загрузка и поиск разрывов…");

    try {
      const res = await fetch("/api/analyze", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Ошибка загрузки");
      state.analysis = data;
      state.pointA = null;
      state.pointB = null;
      state.pickStep = "a";
      state.selectedOptionId = null;
      state.routeOptions = [];
      els.routeList.hidden = true;
      els.connectPanel.hidden = false;
      drawTrack();
      renderSummary(data);
      renderHints(data);
      updatePickUI();
      setStatus(
        data.summary?.mapbox_configured
          ? "Трек на карте. Выберите A и B (или подсказку разрыва), затем постройте маршруты."
          : "Трек загружен, но Mapbox-токен не настроен — маршруты по дорогам недоступны."
      );
    } catch (err) {
      setStatus(err.message || String(err), true);
    } finally {
      els.analyzeBtn.disabled = false;
    }
  });

  els.applyBtn.addEventListener("click", async () => {
    if (!state.analysis || !state.selectedOptionId || !state.connectId) return;
    els.applyBtn.disabled = true;
    setStatus("Применяем выбранный маршрут…");
    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          track_id: state.analysis.track_id,
          selections: { [state.connectId]: state.selectedOptionId },
          export_format: els.exportFormat.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Ошибка применения");

      if (data.track) {
        state.analysis.track = data.track;
        state.analysis.anomalies = data.anomalies || [];
        state.analysis.summary.point_count = data.point_count;
        state.pointA = null;
        state.pointB = null;
        state.pickStep = "a";
        state.selectedOptionId = null;
        state.connectId = null;
        state.routeOptions = [];
        els.routeList.hidden = true;
        drawTrack();
        renderSummary(state.analysis);
        renderHints(state.analysis);
        updatePickUI();
      }

      // Download without leaving the page so next gaps can be fixed
      const a = document.createElement("a");
      a.href = data.download_path;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setStatus(`Маршрут применён (${data.point_count} точек). Файл скачан — можно чинить следующий разрыв.`);
    } catch (err) {
      setStatus(err.message || String(err), true);
    } finally {
      els.applyBtn.disabled = !state.selectedOptionId;
    }
  });

  updatePickUI();
  checkHealth();
})();
