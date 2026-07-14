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
  // Country borders — drawn in their own pane above the WMS raster layer
  // (which the CARTO basemap's own borders would otherwise be hidden
  // under), so they stay crisp regardless of which field/opacity is
  // active. Sourced from Natural Earth's public 50m admin-0 boundaries via
  // jsDelivr's GitHub CDN mirror, which serves CORS-friendly static files —
  // no backend or API key needed, consistent with the rest of this site.
  // ---------------------------------------------------------------------
  const bordersPane = map.createPane("borders");
  bordersPane.style.zIndex = 450; // above tile panes (200s) and the WMS overlay pane (400s), below markers/popups
  bordersPane.style.pointerEvents = "none";

  const BORDERS_GEOJSON_URL =
    "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector/geojson/ne_50m_admin_0_countries.geojson";

  fetch(BORDERS_GEOJSON_URL)
    .then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then((geojson) => {
      // A dark, wider "halo" line underneath a thinner bright line keeps
      // borders legible over any raster color (bright fields would wash out
      // a plain light-grey line on its own).
      L.geoJSON(geojson, {
        pane: "borders",
        interactive: false,
        style: { color: "rgba(0, 0, 0, 0.55)", weight: 2.4, fill: false },
      }).addTo(map);
      L.geoJSON(geojson, {
        pane: "borders",
        interactive: false,
        style: { color: "rgba(255, 255, 255, 0.85)", weight: 1, fill: false },
      }).addTo(map);
    })
    .catch((err) => {
      // Non-fatal — the map still works without borders, just less legible.
      console.warn("Could not load country borders overlay:", err.message);
    });

  // ---------------------------------------------------------------------
  // Client-side grid render (gridrender.js) — draws the active field using
  // OUR OWN palettes.js colors + contour lines, sourced from FMI's open
  // data (see gridrender.js header for the full explanation). Sits above
  // the WMS tile layer and below borders; if it fails for any reason the
  // WMS layer underneath is simply left visible, unchanged.
  // ---------------------------------------------------------------------
  const gridPane = map.createPane("gridrender");
  gridPane.style.zIndex = 420;
  gridPane.style.pointerEvents = "none";

  const fillCanvas = document.createElement("canvas");
  const contourCanvas = document.createElement("canvas");
  for (const c of [fillCanvas, contourCanvas]) {
    c.style.position = "absolute";
    c.style.top = "0";
    c.style.left = "0";
    gridPane.appendChild(c);
  }

  let renderRequestId = 0;
  let renderDebounceTimer = null;

  function clearGridRender() {
    const fctx = fillCanvas.getContext("2d");
    const cctx = contourCanvas.getContext("2d");
    fctx.clearRect(0, 0, fillCanvas.width, fillCanvas.height);
    cctx.clearRect(0, 0, contourCanvas.width, contourCanvas.height);
  }

  function setRenderStatus(text, colorVar) {
    const note = document.getElementById("render-status-note");
    if (!note) return;
    note.textContent = text;
    note.style.color = colorVar ? `var(${colorVar})` : "";
  }

  async function attemptClientRender() {
    const field = state.activeLayer;
    const myId = ++renderRequestId;

    if (!field || !field.kind || !window.GridRender || !window.GridRender.isSupported(field.kind)) {
      clearGridRender();
      setRenderStatus("");
      return;
    }

    const timeVal = field.times[state.activeTimeIndex];
    if (!timeVal) {
      clearGridRender();
      return;
    }

    setRenderStatus("Custom render: loading…", "--text-muted");

    const bounds = map.getBounds();
    // Small pad so the fetched area covers slightly beyond the visible
    // viewport, avoiding a hard transparent edge right at the map border.
    const pad = 0.15;
    const bbox = [
      bounds.getWest() - pad, bounds.getSouth() - pad,
      bounds.getEast() + pad, bounds.getNorth() + pad,
    ];

    try {
      const grid = await window.GridRender.loadFieldGrid(field.kind, bbox, timeVal);
      if (myId !== renderRequestId) return; // superseded by a newer request

      const size = map.getSize();
      for (const c of [fillCanvas, contourCanvas]) {
        c.style.width = size.x + "px";
        c.style.height = size.y + "px";
      }

      const containerPointToLatLng = (px, py) => map.containerPointToLatLng([px, py]);
      window.GridRender.renderFill(fillCanvas, grid, containerPointToLatLng, size.x, size.y);

      contourCanvas.width = size.x;
      contourCanvas.height = size.y;
      const latLngToContainerPoint = (lat, lon) => map.latLngToContainerPoint([lat, lon]);
      const palette = METAR_PALETTES[grid.palette];
      const levels = palette ? palette.stops.map((s) => s[0]) : [];
      window.GridRender.renderContours(contourCanvas, grid, latLngToContainerPoint, levels);

      if (myId !== renderRequestId) return;
      // Client render succeeded — dim the WMS layer underneath rather than
      // removing it outright, so a partial/edge-of-bbox gap in our canvas
      // still shows *something* instead of a hard transparent hole.
      if (state.wmsLayerObj) state.wmsLayerObj.setOpacity(0.15);
      setRenderStatus("Custom render: active (FMI + your palettes)", "--accent-aurora");
    } catch (err) {
      if (myId !== renderRequestId) return;
      console.warn("Client-side grid render failed, falling back to WMS:", err.message);
      clearGridRender();
      if (state.wmsLayerObj) state.wmsLayerObj.setOpacity(0.75);
      setRenderStatus("Custom render unavailable — showing MET Norway's WMS instead", "--accent-amber");
    }
  }

  function scheduleClientRender() {
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(attemptClientRender, 400);
  }

  map.on("moveend zoomend resize", () => {
    if (state.activeLayer && state.activeLayer.kind && window.GridRender && window.GridRender.isSupported(state.activeLayer.kind)) {
      scheduleClientRender();
    }
  });

  window.addEventListener("resize", () => map.invalidateSize());

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
      const extraDims = {}; // e.g. { elevation: "0", depth: "2" } — dimensions other than time
      const dimNodes = Array.from(node.getElementsByTagName("Dimension"));
      for (const d of dimNodes) {
        const dimName = (d.getAttribute("name") || "").toLowerCase();
        if (dimName === "time") {
          if (d.textContent.trim()) times = parseTimeDimension(d.textContent.trim());
        } else if (dimName && dimName !== "reference_time") {
          // Take the server's declared default if present, else the first
          // listed value — some WMS servers 400/return blank tiles if a
          // non-time dimension a layer declares isn't supplied at all.
          const def = d.getAttribute("default");
          const first = d.textContent.trim().split(",")[0].trim();
          extraDims[dimName] = def || first || undefined;
        }
      }
      out.push({ name, title, times, extraDims });
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

    // Layers whose name/title suggest they're a derived probability or
    // threshold-exceedance product, not the raw physical quantity — e.g. a
    // "probability of CAPE > 500 J/kg" layer can otherwise get matched by a
    // loose "cape" substring search and silently replace the real CAPE
    // field. Filtered out before matching, for every field, not just CAPE,
    // since "probability of precipitation" could equally hijack "precip".
    const isDerivedProduct = (l) => {
      const hay = (l.name + " " + l.title).toLowerCase();
      return hay.includes("probability") || hay.includes("percentile") || hay.includes("exceedance");
    };
    const candidateLayers = state.layers.filter((l) => !isDerivedProduct(l));

    const matched = [];
    const used = new Set();
    for (const pref of MEPS_CONFIG.PREFERRED_FIELDS) {
      const found = candidateLayers.find((l) => {
        const hay = (l.name + " " + l.title).toLowerCase();
        return pref.match.some((m) => hay.includes(m.toLowerCase()));
      });
      if (found && !used.has(found.name)) {
        matched.push({ ...found, label: pref.label, unit: pref.unit, kind: pref.kind, convert: (v) => v });
        used.add(found.name);
      }
    }
    // Add any remaining layers (capped) so nothing discoverable is hidden.
    // Derived/probability products are still listed here (just not
    // auto-selected as the "real" field) so they're not hidden entirely.
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
    clearGridRender();
    scheduleClientRender();
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
        // Kind-scoped overrides take priority over the global CF table —
        // "m" means very different things for snow depth vs. e.g.
        // geopotential height, so this conversion is deliberately scoped to
        // kind === "snow" rather than added to CF_UNIT_CONVERSIONS globally.
        if (field.kind === "snow" && rawUnit === "m") {
          field.unit = "cm";
          field.convert = (v) => v * 100;
        } else {
          const conv = MEPS_CONFIG.CF_UNIT_CONVERSIONS[rawUnit];
          field.unit = conv ? conv.to : rawUnit;
          field.convert = conv ? conv.fn : (v) => v;
        }
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
      scheduleClientRender();
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
      scheduleClientRender();
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
    // Some WMS servers 400 or silently return blank tiles if a layer
    // declares a non-time dimension (e.g. "elevation") and it isn't
    // supplied at all — MSLP failing to render at all, while other fields
    // worked, pointed at exactly this. Forward whatever default we parsed
    // from GetCapabilities for each such dimension.
    if (state.activeLayer.extraDims) {
      for (const [dim, val] of Object.entries(state.activeLayer.extraDims)) {
        if (val !== undefined) wmsOpts[dim] = val;
      }
    }

    state.wmsLayerObj = L.tileLayer.wms(state.wmsBase, wmsOpts);
    state.wmsLayerObj.on("tileerror", (err) => {
      el.wmsStatus.textContent = "tile error (layer/time may be unsupported)";
      el.wmsStatus.style.color = "var(--accent-amber)";
      // Logged (not just silently flagged) so a failure can actually be
      // diagnosed from devtools instead of guessed at blind.
      console.warn("WMS tile failed:", err && err.tile && err.tile.src, err);
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
  // Cursor tag — hover-to-read GetFeatureInfo, updating continuously as the
  // mouse moves rather than requiring a click. Throttled so it doesn't fire
  // a request per pixel of movement, and race-safe (a slow response for an
  // old position can't clobber a newer one) via a monotonically increasing
  // request id.
  // ---------------------------------------------------------------------
  const HOVER_THROTTLE_MS = 120;
  let hoverLastFired = 0;
  let hoverPendingTimer = null;
  let hoverRequestId = 0;

  const cursorTag = document.getElementById("cursor-tag");
  const cursorTagTitle = document.getElementById("cursor-tag-title");
  const cursorTagValue = document.getElementById("cursor-tag-value");
  const cursorTagCoord = document.getElementById("cursor-tag-coord");
  const cursorTagTime = document.getElementById("cursor-tag-time");

  function positionCursorTag(clientX, clientY) {
    const offset = 16;
    const rect = cursorTag.getBoundingClientRect();
    let left = clientX + offset;
    let top = clientY + offset;
    if (left + rect.width > window.innerWidth) left = clientX - rect.width - offset;
    if (top + rect.height > window.innerHeight) top = clientY - rect.height - offset;
    cursorTag.style.left = `${left}px`;
    cursorTag.style.top = `${top}px`;
  }

  map.getContainer().addEventListener("mousemove", (domEvent) => {
    if (!state.activeLayer || !state.wmsBase) return;
    const now = performance.now();
    positionCursorTag(domEvent.clientX, domEvent.clientY);

    if (now - hoverLastFired < HOVER_THROTTLE_MS) {
      clearTimeout(hoverPendingTimer);
      hoverPendingTimer = setTimeout(() => queryAtPoint(domEvent), HOVER_THROTTLE_MS);
      return;
    }
    hoverLastFired = now;
    queryAtPoint(domEvent);
  });

  map.getContainer().addEventListener("mouseleave", () => {
    cursorTag.classList.add("hidden");
  });

  async function queryAtPoint(domEvent) {
    const layer = state.activeLayer;
    if (!layer || !state.wmsBase) return;

    const containerPoint = map.mouseEventToContainerPoint(domEvent);
    const latlng = map.containerPointToLatLng(containerPoint);
    const size = map.getSize();
    const bounds = map.getBounds();
    const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
    const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
    const timeVal = layer.times[state.activeTimeIndex];

    const params = new URLSearchParams({
      service: "WMS",
      version: "1.3.0",
      request: "GetFeatureInfo",
      layers: layer.name,
      query_layers: layer.name,
      crs: "EPSG:3857",
      bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`,
      width: size.x,
      height: size.y,
      i: Math.round(containerPoint.x),
      j: Math.round(containerPoint.y),
      info_format: "text/xml",
      feature_count: "1",
    });
    if (timeVal) params.set("time", timeVal);
    if (layer.extraDims) {
      for (const [dim, val] of Object.entries(layer.extraDims)) {
        if (val !== undefined) params.set(dim, val);
      }
    }

    const url = state.wmsBase + (state.wmsBase.includes("?") ? "&" : "?") + params.toString();

    cursorTag.classList.remove("hidden");
    cursorTagTitle.textContent = layer.label || layer.name;
    cursorTagCoord.textContent = `${latlng.lat.toFixed(2)}°N, ${latlng.lng.toFixed(2)}°E`;
    cursorTagTime.textContent = timeVal ? formatValidLabel(timeVal) : "";

    const myRequestId = ++hoverRequestId;
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (myRequestId !== hoverRequestId) return; // a newer hover position already superseded this

      const raw = extractFeatureValue(text);
      if (raw === null) {
        cursorTagValue.textContent = "no data here";
        cursorTagValue.style.color = "";
        cursorTagValue.title = "";
        return;
      }

      const converted = typeof raw === "number" && layer.convert ? layer.convert(raw) : raw;
      const rounded = typeof converted === "number" ? Math.round(converted * 10) / 10 : converted;

      const range = layer.kind && MEPS_CONFIG.SANITY_RANGES[layer.kind];
      const implausible = range && typeof rounded === "number" && (rounded < range[0] || rounded > range[1]);

      cursorTagValue.textContent = `${rounded} ${layer.unit || ""}`.trim();
      if (implausible) {
        cursorTagValue.textContent += " ⚠";
        cursorTagValue.title = "This reading is outside the physically expected range — " +
          "likely a unit mismatch with the server rather than real weather. " +
          "Raw server value was " + raw + (layer.rawUnit ? " " + layer.rawUnit : "") + ".";
        cursorTagValue.style.color = "#a35b00";
      } else {
        cursorTagValue.style.color = "";
        cursorTagValue.title = "";
      }
    } catch (err) {
      if (myRequestId !== hoverRequestId) return;
      cursorTagValue.textContent = "read failed";
    }
  }

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
        if (isNaN(num)) return m[1].trim();
        // netCDF's classic float32 _FillValue sentinel (≈9.96921e+36) marks
        // "no data" — e.g. a precipitation-accumulation field genuinely has
        // no value at forecast hour 0. Treat it (and its negative form) as
        // missing rather than displaying a nonsense reading.
        if (Math.abs(num) > 1e30) return null;
        return Math.round(num * 10) / 10;
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
