(() => {
  const state = {
    analysis: null,
    selections: {},
    layers: {
      raw: null,
      anomalies: [],
      preview: null,
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
  }

  function toLatLngs(points) {
    return points.map((p) => [p.lat, p.lon]);
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
  }

  function previewSelection() {
    if (state.layers.preview) {
      map.removeLayer(state.layers.preview);
      state.layers.preview = null;
    }
    if (!state.analysis) return;

    const parts = [];
    for (const [anomalyId, optionId] of Object.entries(state.selections)) {
      const opt = state.analysis.options.find((o) => o.id === optionId);
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

    if (!analysis.anomalies.length) {
      els.anomalyList.innerHTML = `<p class="lede">Аномалий не найдено. Можно скачать трек как есть.</p>`;
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
      els.anomalyList.appendChild(card);
    });

    els.applyBtn.disabled = false;
    previewSelection();
  }

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
      drawTrack(data);
      renderSummary(data);
      renderAnomalies(data);
      setStatus(
        data.summary?.mapbox_configured
          ? "Готово. Выберите варианты исправления."
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

  checkHealth();
})();
