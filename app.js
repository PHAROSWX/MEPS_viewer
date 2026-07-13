// app.js — MEPS Viewer
// -----------------------------------------------------------------------------
// Everything here talks directly to MET Norway's public WMS service, live,
// from the browser. No build step, no backend — this is meant to run as-is
// on GitHub Pages. See README.md for how the endpoint fallback works and
// what to do if MET Norway changes their infrastructure again.

(function () {
  "use strict";

  const state = {
    wmsBase: null,
    capsDoc: null,
    layers: [],          // [{name, title, times:[...]}]
    activeLayer: null,
    activeTimeIndex: 0,
    wmsLayerObj: null,   // current Leaflet L.tileLayer.wms
    playTimer: null,
  };

  // ---------------------------------------------------------------------
  // Map setup
  // ---------------------------------------------------------------------
  const map = L.map("map", {
    center: MEPS_CONFIG.MAP_CENTER,
    zoom: MEPS_CONFIG.MAP_ZOOM,
    minZoom: MEPS_CONFIG.MAP_MIN_ZOOM,
    maxZoom: MEPS_CONFIG.MAP_MAX_ZOOM,
    zoomControl: false,
    attributionControl: true,
  });

  L.control.zoom({ position: "bottomleft" }).addTo(map);

  L.tileLayer("https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_nolabels/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors',
    subdomains: "abcd",
    maxZoom: 20,
  }).addTo(map);

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  const el = {
    fieldList: document.getElementById("field-list"),
    legendImg: document.getElementById("legend-img"),
    legendEmpty: document.getElementById("legend-empty"),
    wmsUrlInput: document.getElementById("wms-url"),
    wmsReload: document.getElementById("wms-reload"),
    wmsStatus: document.getElementById("wms-status"),
    deck: document.getElementById("deck"),
    deckToggle: document.getElementById("deck-toggle"),
    tapeSlider: document.getElementById("tape-slider"),
    tapeTicks: document.getElementById("tape-ticks"),
    tapePlay: document.getElementById("tape-play"),
    validTime: document.getElementById("valid-time"),
    leadTime: document.getElementById("lead-time"),
    runTime: document.getElementById("run-time"),
    runAge: document.getElementById("run-age"),
    aboutBtn: document.getElementById("about-btn"),
    aboutClose: document.getElementById("about-close"),
    aboutVeil: document.getElementById("about-veil"),
    stationTagTpl: document.getElementById("station-tag-template"),
  };

  // ---------------------------------------------------------------------
  // UI chrome: deck toggle, about modal
  // ---------------------------------------------------------------------
  el.deckToggle.addEventListener("click", () => el.deck.classList.toggle("collapsed"));
  el.aboutBtn.addEventListener("click", () => el.aboutVeil.classList.add("visible"));
  el.aboutClose.addEventListener("click", () => el.aboutVeil.classList.remove("visible"));
  el.aboutVeil.addEventListener("click", (e) => {
    if (e.target === el.aboutVeil) el.aboutVeil.classList.remove("visible");
  });

  // ---------------------------------------------------------------------
  // Capabilities loading with fallback chain
  // ---------------------------------------------------------------------
  function capabilitiesUrl(base) {
    return base + (base.includes("?") ? "&" : "?") +
      "service=WMS&version=1.3.0&request=GetCapabilities";
  }

  async function tryLoadEndpoint(base) {
    const url = capabilitiesUrl(base);
    el.wmsStatus.textContent = "checking…";
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("bad XML");
    const layers = parseLayers(doc);
    if (!layers.length) throw new Error("no layers found");
    return { doc, layers };
  }

  async function loadCapabilities(preferredBase) {
    const candidates = preferredBase
      ? [preferredBase, ...MEPS_CONFIG.CANDIDATE_ENDPOINTS]
      : MEPS_CONFIG.CANDIDATE_ENDPOINTS;

    let lastErr = null;
    for (const base of candidates) {
      try {
        const { doc, layers } = await tryLoadEndpoint(base);
        state.wmsBase = base;
        state.capsDoc = doc;
        state.layers = layers;
        el.wmsUrlInput.value = base;
        el.wmsStatus.textContent = "connected";
        el.wmsStatus.style.color = "var(--accent-aurora)";
        buildFieldList();
        return;
      } catch (err) {
        lastErr = err;
        console.warn("MEPS endpoint failed:", base, err.message);
      }
    }
    el.wmsStatus.textContent = "unreachable";
    el.wmsStatus.style.color = "var(--accent-amber)";
    el.fieldList.innerHTML =
      '<p class="deck-note">Could not reach any known MEPS WMS endpoint (' +
      (lastErr ? lastErr.message : "unknown error") +
      "). MET Norway may have moved the service — paste a current GetCapabilities URL above, or see README.md.</p>";
  }

  // ---------------------------------------------------------------------
  // Parse WMS GetCapabilities XML into a flat layer list with time steps
  // ---------------------------------------------------------------------
  function parseLayers(doc) {
    const layerNodes = Array.from(doc.getElementsByTagName("Layer")).filter(
      (n) => n.getElementsByTagName("Name").length > 0 &&
             n.getElementsByTagName("Name")[0].parentNode === n
    );

    const out = [];
    for (const node of layerNodes) {
      const nameNode = node.querySelector(":scope > Name");
      const titleNode = node.querySelector(":scope > Title");
      if (!nameNode) continue;
      const name = nameNode.textContent.trim();
      const title = titleNode ? titleNode.textContent.trim() : name;

      let times = [];
      const dimNode = Array.from(node.getElementsByTagName("Dimension")).find(
        (d) => (d.getAttribute("name") || "").toLowerCase() === "time"
      );
      if (dimNode && dimNode.textContent.trim()) {
        times = parseTimeDimension(dimNode.textContent.trim());
      }
      out.push({ name, title, times });
    }
    return out;
  }

  function parseTimeDimension(raw) {
    // Handles comma-separated ISO list, and start/stop/period ranges.
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const times = [];
    for (const part of parts) {
      if (part.includes("/")) {
        const [start, stop, period] = part.split("/");
        times.push(...expandTimeRange(start, stop, period));
      } else {
        times.push(part);
      }
    }
    return times;
  }

  function expandTimeRange(start, stop, period) {
    // Minimal ISO8601 duration support for common cases like PT1H, PT3H.
    const match = /^PT(\d+)H$/.exec(period || "");
    const stepHours = match ? parseInt(match[1], 10) : 1;
    const startDate = new Date(start);
    const stopDate = new Date(stop);
    const out = [];
    let cur = new Date(startDate);
    let guard = 0;
    while (cur <= stopDate && guard < 500) {
      out.push(cur.toISOString());
      cur = new Date(cur.getTime() + stepHours * 3600 * 1000);
      guard++;
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Field list (layer picker) — curated ordering via PREFERRED_FIELDS,
  // falling back to whatever raw layers were found.
  // ---------------------------------------------------------------------
  function buildFieldList() {
    el.fieldList.innerHTML = "";

    const matched = [];
    const used = new Set();
    for (const pref of MEPS_CONFIG.PREFERRED_FIELDS) {
      const found = state.layers.find((l) => {
        const hay = (l.name + " " + l.title).toLowerCase();
        return pref.match.some((m) => hay.includes(m.toLowerCase()));
      });
      if (found && !used.has(found.name)) {
        matched.push({ ...found, label: pref.label, unit: pref.unit, kind: pref.kind, convert: (v) => v });
        used.add(found.name);
      }
    }
    // Add any remaining layers (capped) so nothing discoverable is hidden.
    const rest = state.layers.filter((l) => !used.has(l.name)).slice(0, 12);
    for (const r of rest) matched.push({ ...r, label: r.title, unit: "", kind: null, convert: (v) => v });

    if (!matched.length) {
      el.fieldList.innerHTML = '<p class="deck-note">No layers found in capabilities document.</p>';
      return;
    }

    matched.forEach((field, idx) => {
      const btn = document.createElement("button");
      btn.className = "field-btn";
      btn.innerHTML = `<span>${escapeHtml(field.label)}</span><span class="unit">${escapeHtml(field.unit || "")}</span>`;
      btn.addEventListener("click", () => selectField(field, btn));
      el.fieldList.appendChild(btn);
      if (idx === 0) selectField(field, btn);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------------------------------------------------------------------
  // Selecting a field: swap the WMS tile layer, rebuild the time slider,
  // fetch the legend graphic.
  // ---------------------------------------------------------------------
  async function selectField(field, btnEl) {
    document.querySelectorAll(".field-btn").forEach((b) => b.classList.remove("active"));
    if (btnEl) btnEl.classList.add("active");

    state.activeLayer = field;
    state.activeTimeIndex = field.times.length
      ? Math.min(state.activeTimeIndex, field.times.length - 1)
      : 0;

    rebuildTimeline(field);
    updateWmsLayer();
    updateLegend(field);
    updateRunClock(field);
    await resolveServerUnits(field); // may correct field.unit once the server responds
  }

  // ---------------------------------------------------------------------
  // Ask the server what unit this layer is actually in (ncWMS's
  // non-standard GetMetadata&item=layerDetails request returns this as
  // JSON), rather than trusting our own guess in config.js. Falls back to
  // the configured default if the server doesn't support this request.
  // ---------------------------------------------------------------------
  async function resolveServerUnits(field) {
    const url = state.wmsBase +
      (state.wmsBase.includes("?") ? "&" : "?") +
      `request=GetMetadata&item=layerDetails&layerName=${encodeURIComponent(field.name)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const rawUnit = data && (data.units || data.unit);
      if (rawUnit && field === state.activeLayer) {
        field.rawUnit = rawUnit;
        const conv = MEPS_CONFIG.CF_UNIT_CONVERSIONS[rawUnit];
        field.unit = conv ? conv.to : rawUnit;
        field.convert = conv ? conv.fn : (v) => v;
        // Refresh anything already showing the old unit guess.
        const btn = [...document.querySelectorAll(".field-btn")].find((b) => b.classList.contains("active"));
        if (btn) {
          const unitSpan = btn.querySelector(".unit");
          if (unitSpan) unitSpan.textContent = field.unit;
        }
      }
    } catch (err) {
      // Server doesn't support GetMetadata (not all WMS implementations do) —
      // silently keep the config.js default. Not fatal.
    }
  }

  function rebuildTimeline(field) {
    const n = field.times.length;
    el.tapeSlider.min = 0;
    el.tapeSlider.max = Math.max(n - 1, 0);
    el.tapeSlider.value = state.activeTimeIndex;
    el.tapeTicks.innerHTML = "";
    if (!n) {
      el.validTime.textContent = "—";
      el.leadTime.textContent = "";
      return;
    }
    // Sparse tick labels (start, quarter marks, end) to avoid clutter.
    const tickIdxs = new Set([0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1]);
    [...tickIdxs].sort((a, b) => a - b).forEach((i) => {
      const span = document.createElement("span");
      span.textContent = formatHour(field.times[i]);
      el.tapeTicks.appendChild(span);
    });
    updateTimeReadout(field);
  }

  function formatHour(iso) {
    const d = new Date(iso);
    return d.getUTCHours().toString().padStart(2, "0") + "z";
  }

  function updateTimeReadout(field) {
    const iso = field.times[state.activeTimeIndex];
    if (!iso) return;
    const d = new Date(iso);
    el.validTime.textContent = d.toISOString().slice(0, 16).replace("T", " ") + "Z";
    if (field.times.length) {
      const first = new Date(field.times[0]);
      const leadH = Math.round((d - first) / 3600000);
      el.leadTime.textContent = "+" + String(leadH).padStart(2, "0") + "h";
    }
  }

  el.tapeSlider.addEventListener("input", () => {
    state.activeTimeIndex = parseInt(el.tapeSlider.value, 10);
    if (state.activeLayer) {
      updateTimeReadout(state.activeLayer);
      updateWmsLayer();
    }
  });

  el.tapePlay.addEventListener("click", () => {
    if (state.playTimer) {
      clearInterval(state.playTimer);
      state.playTimer = null;
      el.tapePlay.textContent = "▶";
      return;
    }
    el.tapePlay.textContent = "❚❚";
    state.playTimer = setInterval(() => {
      if (!state.activeLayer || !state.activeLayer.times.length) return;
      state.activeTimeIndex = (state.activeTimeIndex + 1) % state.activeLayer.times.length;
      el.tapeSlider.value = state.activeTimeIndex;
      updateTimeReadout(state.activeLayer);
      updateWmsLayer();
    }, 900);
  });

  // ---------------------------------------------------------------------
  // WMS tile layer
  // ---------------------------------------------------------------------
  function updateWmsLayer() {
    if (!state.activeLayer) return;
    if (state.wmsLayerObj) {
      map.removeLayer(state.wmsLayerObj);
      state.wmsLayerObj = null;
    }
    const timeVal = state.activeLayer.times[state.activeTimeIndex];
    const wmsOpts = {
      layers: state.activeLayer.name,
      format: "image/png",
      transparent: true,
      version: "1.3.0",
      opacity: 0.75,
      attribution: "MET Norway",
    };
    if (timeVal) wmsOpts.time = timeVal;

    state.wmsLayerObj = L.tileLayer.wms(state.wmsBase, wmsOpts);
    state.wmsLayerObj.on("tileerror", () => {
      el.wmsStatus.textContent = "tile error (layer/time may be unsupported)";
      el.wmsStatus.style.color = "var(--accent-amber)";
    });
    state.wmsLayerObj.addTo(map);
  }

  // ---------------------------------------------------------------------
  // Legend: prefer the user's own QML color-ramp (palettes.js) so the
  // legend always matches their color science, regardless of whatever
  // default palette the WMS server happens to render tiles with. Falls
  // back to the server's GetLegendGraphic when there's no custom palette
  // for this field.
  // ---------------------------------------------------------------------
  const legendCanvas = document.getElementById("legend-canvas");
  const legendNote = document.getElementById("legend-source-note");

  function updateLegend(field) {
    const paletteName = field.kind && PALETTE_BY_KIND[field.kind];

    if (paletteName) {
      legendCanvas.style.display = "block";
      el.legendImg.style.display = "none";
      el.legendEmpty.style.display = "none";
      renderPaletteLegend(legendCanvas, paletteName);
      legendNote.textContent = `Custom palette (${paletteName}.qml) — colors are reference only; ` +
        `map tiles above still use MET Norway's own WMS rendering.`;
      return;
    }

    legendCanvas.style.display = "none";
    legendNote.textContent = "";
    const url = state.wmsBase +
      (state.wmsBase.includes("?") ? "&" : "?") +
      `service=WMS&request=GetLegendGraphic&format=image/png&layer=${encodeURIComponent(field.name)}&width=40&height=180`;
    el.legendImg.onerror = () => {
      el.legendImg.style.display = "none";
      el.legendEmpty.style.display = "block";
      el.legendEmpty.textContent = "Legend not available for this layer";
    };
    el.legendImg.onload = () => {
      el.legendImg.style.display = "block";
      el.legendEmpty.style.display = "none";
    };
    el.legendImg.src = url;
  }

  // ---------------------------------------------------------------------
  // Run clock — approximated from the first timestep of the active layer
  // (for a continuously-updated "latest" aggregation this is effectively
  // the analysis / forecast-reference time).
  // ---------------------------------------------------------------------
  function updateRunClock(field) {
    if (!field.times.length) {
      el.runTime.textContent = "— — —";
      el.runAge.textContent = "age unknown";
      return;
    }
    const first = new Date(field.times[0]);
    el.runTime.textContent = first.toISOString().slice(0, 16).replace("T", " ") + "Z";
    tickAge(first);
    clearInterval(state._ageTimer);
    state._ageTimer = setInterval(() => tickAge(first), 60000);
  }

  function tickAge(sinceDate) {
    const mins = Math.max(0, Math.round((Date.now() - sinceDate.getTime()) / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    el.runAge.textContent = `run start ${h}h ${m}m ago`;
  }

  // ---------------------------------------------------------------------
  // Station tag — click-to-read GetFeatureInfo, the signature interaction.
  // ---------------------------------------------------------------------
  map.on("click", async (e) => {
    if (!state.activeLayer || !state.wmsBase) return;

    const size = map.getSize();
    const bounds = map.getBounds();
    const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
    const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
    const timeVal = state.activeLayer.times[state.activeTimeIndex];

    const params = new URLSearchParams({
      service: "WMS",
      version: "1.3.0",
      request: "GetFeatureInfo",
      layers: state.activeLayer.name,
      query_layers: state.activeLayer.name,
      crs: "EPSG:3857",
      bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`,
      width: size.x,
      height: size.y,
      i: Math.round(e.containerPoint.x),
      j: Math.round(e.containerPoint.y),
      info_format: "text/xml",
      feature_count: "1",
    });
    if (timeVal) params.set("time", timeVal);

    const url = state.wmsBase + (state.wmsBase.includes("?") ? "&" : "?") + params.toString();

    const tagFrag = el.stationTagTpl.content.cloneNode(true);
    const tagRoot = tagFrag.querySelector(".station-tag");
    tagFrag.querySelector(".tag-title").textContent = state.activeLayer.label || state.activeLayer.name;
    tagFrag.querySelector(".tag-value").textContent = "reading…";
    tagFrag.querySelector(".tag-coord").textContent =
      `${e.latlng.lat.toFixed(2)}°N, ${e.latlng.lng.toFixed(2)}°E`;
    tagFrag.querySelector(".tag-time").textContent = timeVal ? formatValidLabel(timeVal) : "";

    const popup = L.popup({ closeButton: true, className: "" })
      .setLatLng(e.latlng)
      .setContent(tagRoot)
      .openOn(map);

    try {
      const res = await fetch(url);
      const text = await res.text();
      const raw = extractFeatureValue(text);
      const valueEl = tagRoot.querySelector(".tag-value");

      if (raw === null) {
        valueEl.textContent = "no data here";
        return;
      }

      const layer = state.activeLayer;
      const converted = typeof raw === "number" && layer.convert ? layer.convert(raw) : raw;
      const rounded = typeof converted === "number" ? Math.round(converted * 10) / 10 : converted;

      const range = layer.kind && MEPS_CONFIG.SANITY_RANGES[layer.kind];
      const implausible = range && typeof rounded === "number" && (rounded < range[0] || rounded > range[1]);

      valueEl.textContent = `${rounded} ${layer.unit || ""}`.trim();
      if (implausible) {
        valueEl.textContent += " ⚠";
        valueEl.title = "This reading is outside the physically expected range — " +
          "likely a unit mismatch with the server rather than real weather. " +
          "Raw server value was " + raw + (layer.rawUnit ? " " + layer.rawUnit : "") + ".";
        valueEl.style.color = "#a35b00";
      }
    } catch (err) {
      tagRoot.querySelector(".tag-value").textContent = "read failed";
    }
  });

  function formatValidLabel(iso) {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + "Z";
  }

  function extractFeatureValue(xmlText) {
    // ncWMS-style GetFeatureInfo text/xml typically contains a <value> or
    // <BoxFillValue> style tag. Try a couple of patterns; fall back to null.
    const patterns = [/<value>([^<]+)<\/value>/i, /<BoxFillValue>([^<]+)<\/BoxFillValue>/i, /"value"\s*:\s*"?([\-0-9.]+)"?/i];
    for (const re of patterns) {
      const m = re.exec(xmlText);
      if (m) {
        const num = parseFloat(m[1]);
        return isNaN(num) ? m[1].trim() : Math.round(num * 10) / 10;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Manual "download this run" — pulls the active field/time as NetCDF via
  // THREDDS's NetCDF Subset Service (NCSS), which lives alongside the WMS
  // service on the same dataset. THREDDS convention is that a WMS endpoint
  // at .../thredds/wms/<path> has a sibling NCSS endpoint at
  // .../thredds/ncss/grid/<path> — we derive it from wmsBase rather than
  // hard-coding a second URL. If MET Norway's NCSS is laid out differently
  // this will surface as a clear failed-download message, not silent data.
  // ---------------------------------------------------------------------
  const downloadBtn = document.getElementById("download-run-btn");
  downloadBtn.addEventListener("click", async () => {
    if (!state.activeLayer || !state.wmsBase) return;
    const originalLabel = downloadBtn.textContent;
    downloadBtn.textContent = "Fetching…";
    downloadBtn.disabled = true;
    try {
      const ncssBase = state.wmsBase.replace("/wms/", "/ncss/grid/");
      if (ncssBase === state.wmsBase) throw new Error("could not derive NCSS URL from this WMS base");

      const timeVal = state.activeLayer.times[state.activeTimeIndex];
      const params = new URLSearchParams({
        var: state.activeLayer.name,
        accept: "netcdf",
      });
      if (timeVal) {
        params.set("time_start", timeVal);
        params.set("time_end", timeVal);
      }
      const url = ncssBase + (ncssBase.includes("?") ? "&" : "?") + params.toString();

      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = (timeVal || new Date().toISOString()).replace(/[:]/g, "");
      a.href = objectUrl;
      a.download = `meps_${state.activeLayer.name}_${stamp}.nc`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      alert(
        "Couldn't download this field from THREDDS's NetCDF Subset Service: " + err.message +
        "\n\nThis is a separate service from the WMS tiles (which are still working). " +
        "See README.md → 'Automated model-run fetching' for the scheduled alternative."
      );
    } finally {
      downloadBtn.textContent = originalLabel;
      downloadBtn.disabled = false;
    }
  });

  // ---------------------------------------------------------------------
  // Source panel — manual endpoint override
  // ---------------------------------------------------------------------
  el.wmsReload.addEventListener("click", () => {
    const val = el.wmsUrlInput.value.trim();
    loadCapabilities(val || undefined);
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  loadCapabilities();
})();
