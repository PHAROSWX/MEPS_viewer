// gridrender.js
// -----------------------------------------------------------------------------
// Renders MEPS fields on the map using OUR OWN color palettes (palettes.js)
// instead of MET Norway's server-rendered WMS tiles, plus contour lines —
// the feature explicitly asked for after the WMS-only approach could only
// match colors in the legend, not on the map itself.
//
// How it works, end to end:
//   1. Fetch a small grid subset from FMI's open data Download Service
//      (opendata.fmi.fi/download), requesting projection=EPSG:4326 so we
//      get back a plain regular lat/lon grid — this sidesteps MEPS's native
//      Lambert Conformal Conic projection entirely, which would otherwise
//      need real map-projection math to place correctly.
//   2. Parse the response (NetCDF-3 binary) client-side with netcdfjs, a
//      pure-JS reader loaded on demand from esm.sh (no build step/bundler
//      needed for this project, so a CDN ES-module import is the simplest
//      way to pull in a real npm package here).
//   3. Paint a canvas, one pixel at a time, by converting each canvas pixel
//      to a lat/lon (via Leaflet), sampling the nearest grid cell, and
//      color it via palettes.js.
//   4. Run a small marching-squares implementation over the same grid to
//      draw contour lines at each palette's own stop values, with inline
//      labels — matching the reference isotherm-map look.
//
// HONESTY NOTE, same as everywhere else this project talks to a live
// service: this has NOT been tested against the real FMI server or a real
// browser (built in a sandboxed environment with no network access to
// opendata.fmi.fi). What IS verified: these exact FMI parameter names
// (Temperature, Pressure, WindUMS, WindVMS, Precipitation1h,
// TotalCloudCover, CAPE) were accepted together in a real successful fetch
// during this project's development (see scripts/fetch_meps.py history).
// What is NOT verified: FMI's exact NetCDF variable/dimension naming for
// lat/lon and the data variable, or browser CORS headers on this endpoint.
// This module is written defensively because of that: if anything about
// the response doesn't match what it expects, it logs a clear reason to
// the console and simply doesn't render — the existing WMS tile layer
// underneath is untouched and stays visible either way. This is designed
// to fail safe, not to fail loudly in the user's face.
// -----------------------------------------------------------------------------

window.GridRender = (function () {
  "use strict";

  const FMI_DOWNLOAD_URL = "https://opendata.fmi.fi/download";
  const FMI_PRODUCER = "harmonie_scandinavia_surface";
  const NETCDFJS_CDN = "https://esm.sh/netcdfjs@4.0.0";

  // Which of our field "kind"s can be client-rendered, and how to get their
  // value from FMI's parameters. `params` are FMI parameter names to fetch;
  // `compute(vars)` turns the fetched variable(s) into the display value
  // (identity for most, vector magnitude for wind).
  const FIELD_RECIPES = {
    temperature: { params: ["Temperature"], compute: (v) => v.Temperature, palette: "temperature" },
    pressure: { params: ["Pressure"], compute: (v) => v.Pressure, palette: "mslp" },
    cloud: { params: ["TotalCloudCover"], compute: (v) => v.TotalCloudCover, palette: "cloud" },
    cape: { params: ["CAPE"], compute: (v) => v.CAPE, palette: "cape" },
    precip: { params: ["Precipitation1h"], compute: (v) => v.Precipitation1h, palette: "precip" },
    wind: {
      params: ["WindUMS", "WindVMS"],
      compute: (v) => Math.sqrt(v.WindUMS * v.WindUMS + v.WindVMS * v.WindVMS),
      palette: "gusts", // sustained speed here, not gusts specifically — see palettes.js note
    },
    // snow intentionally omitted — no confirmed-working FMI parameter name yet.
  };

  let netcdfReaderPromise = null;
  function loadNetCDFReader() {
    if (!netcdfReaderPromise) {
      netcdfReaderPromise = import(NETCDFJS_CDN)
        .then((mod) => mod.NetCDFReader)
        .catch((err) => {
          netcdfReaderPromise = null; // allow retry on a later call
          throw new Error("Could not load netcdfjs from CDN: " + err.message);
        });
    }
    return netcdfReaderPromise;
  }

  // ---------------------------------------------------------------------
  // Fetch + parse
  // ---------------------------------------------------------------------

  async function fetchParam(fmiParam, bbox, timeIso) {
    const [west, south, east, north] = bbox;
    const params = new URLSearchParams({
      producer: FMI_PRODUCER,
      param: fmiParam,
      format: "netcdf",
      projection: "EPSG:4326",
      starttime: timeIso,
      endtime: timeIso,
      timestep: "60",
      bbox: `${west},${south},${east},${north}`,
    });
    const url = FMI_DOWNLOAD_URL + "?" + params.toString();
    const res = await fetch(url);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`FMI HTTP ${res.status} for ${fmiParam}: ${bodyText.slice(0, 200)}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 200) throw new Error(`suspiciously small FMI response for ${fmiParam} (${buf.byteLength} bytes)`);
    return buf;
  }

  // Pulls {data2d, lats, lons, fillValue} out of a NetCDFReader instance for
  // whichever variable looks like "the" data variable (i.e. not a
  // coordinate/time variable). Written defensively since FMI's exact
  // variable naming hasn't been confirmed live — see file header.
  function extractGrid(reader) {
    const COORD_NAMES = new Set(["time", "lat", "latitude", "lon", "longitude", "x", "y", "rotated_pole"]);
    const vars = reader.variables || [];
    if (!vars.length) throw new Error("NetCDF file has no variables");

    const findVar = (patterns) =>
      vars.find((v) => patterns.some((p) => v.name.toLowerCase().includes(p)));

    const latVar = findVar(["latitude", "lat"]);
    const lonVar = findVar(["longitude", "lon"]);
    if (!latVar || !lonVar) throw new Error("Could not find latitude/longitude variables in NetCDF response");

    const dataVar = vars.find((v) => !COORD_NAMES.has(v.name.toLowerCase()) && v.dimensions.length >= 2);
    if (!dataVar) throw new Error("Could not find a 2D+ data variable in NetCDF response");

    const lats = flatten(reader.getDataVariable(latVar.name));
    const lons = flatten(reader.getDataVariable(lonVar.name));
    const rawData = reader.getDataVariable(dataVar.name);
    const flatData = flatten(rawData);

    const fillAttr = (dataVar.attributes || []).find((a) => a.name === "_FillValue" || a.name === "missing_value");
    const fillValue = fillAttr ? fillAttr.value : null;

    // Expect the data to be shaped [..., ny, nx] with ny=lats.length, nx=lons.length
    // (possibly with a leading singleton time dim, already flattened away here
    // as long as its size is 1 — which it is, since we requested one timestep).
    const ny = lats.length;
    const nx = lons.length;
    if (flatData.length !== ny * nx) {
      throw new Error(`Grid size mismatch: data has ${flatData.length} values, expected ${ny}x${nx}=${ny * nx}`);
    }

    return { data: flatData, lats, lons, nx, ny, fillValue };
  }

  function flatten(nested) {
    if (ArrayBuffer.isView(nested)) return nested; // already a typed array
    const out = [];
    (function walk(a) {
      for (const item of a) {
        if (Array.isArray(item) || ArrayBuffer.isView(item)) walk(item);
        else out.push(item);
      }
    })(nested);
    return out;
  }

  // ---------------------------------------------------------------------
  // Public: fetch + parse one field's grid(s), combining multi-param
  // fields (wind) via their recipe's compute().
  // ---------------------------------------------------------------------
  async function loadFieldGrid(kind, bbox, timeIso) {
    const recipe = FIELD_RECIPES[kind];
    if (!recipe) throw new Error(`No client-render recipe for field kind "${kind}"`);

    const NetCDFReader = await loadNetCDFReader();

    const grids = {};
    let shape = null;
    for (const param of recipe.params) {
      const buf = await fetchParam(param, bbox, timeIso);
      const reader = new NetCDFReader(buf);
      const g = extractGrid(reader);
      grids[param] = g;
      if (!shape) shape = { nx: g.nx, ny: g.ny, lats: g.lats, lons: g.lons };
      else if (g.nx !== shape.nx || g.ny !== shape.ny) {
        throw new Error(`Grid shape mismatch between ${recipe.params.join("/")} — got ${g.nx}x${g.ny} vs ${shape.nx}x${shape.ny}`);
      }
    }

    const n = shape.nx * shape.ny;
    const combined = new Float64Array(n);
    const isNoData = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const vals = {};
      let anyMissing = false;
      for (const param of recipe.params) {
        const g = grids[param];
        const v = g.data[i];
        if (g.fillValue !== null && Math.abs(v - g.fillValue) < 1e-3) anyMissing = true;
        if (Math.abs(v) > 1e30) anyMissing = true; // netCDF classic fill sentinel, belt-and-suspenders
        vals[param] = v;
      }
      if (anyMissing) {
        isNoData[i] = 1;
      } else {
        combined[i] = recipe.compute(vals);
      }
    }

    return {
      data: combined,
      isNoData,
      lats: shape.lats,
      lons: shape.lons,
      nx: shape.nx,
      ny: shape.ny,
      palette: recipe.palette,
    };
  }

  // ---------------------------------------------------------------------
  // Canvas fill render — one pixel at a time, sampling nearest grid cell.
  // `containerPointToLatLngFn` is injected so this module doesn't need to
  // know about the Leaflet map instance directly.
  // ---------------------------------------------------------------------
  function renderFill(canvas, grid, containerPointToLatLngFn, width, height) {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imgData = ctx.createImageData(width, height);

    const latMin = Math.min(grid.lats[0], grid.lats[grid.ny - 1]);
    const latMax = Math.max(grid.lats[0], grid.lats[grid.ny - 1]);
    const lonMin = Math.min(grid.lons[0], grid.lons[grid.nx - 1]);
    const lonMax = Math.max(grid.lons[0], grid.lons[grid.nx - 1]);

    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const latlng = containerPointToLatLngFn(px, py);
        if (latlng.lat < latMin || latlng.lat > latMax || latlng.lng < lonMin || latlng.lng > lonMax) {
          continue; // leave transparent — outside the fetched bbox
        }
        const rowFrac = (latlng.lat - grid.lats[0]) / (grid.lats[grid.ny - 1] - grid.lats[0]);
        const colFrac = (latlng.lng - grid.lons[0]) / (grid.lons[grid.nx - 1] - grid.lons[0]);
        const row = Math.max(0, Math.min(grid.ny - 1, Math.round(rowFrac * (grid.ny - 1))));
        const col = Math.max(0, Math.min(grid.nx - 1, Math.round(colFrac * (grid.nx - 1))));
        const idx = row * grid.nx + col;
        if (grid.isNoData[idx]) continue;

        const hex = paletteColorAt(grid.palette, grid.data[idx]);
        if (!hex) continue;
        const [r, g, b] = hexToRgbTriplet(hex);
        const pi = (py * width + px) * 4;
        imgData.data[pi] = r;
        imgData.data[pi + 1] = g;
        imgData.data[pi + 2] = b;
        imgData.data[pi + 3] = Math.round(255 * 0.75); // match the WMS layer's own opacity convention
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function hexToRgbTriplet(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // ---------------------------------------------------------------------
  // Contours — marching squares on the source (lat/lon) grid, then each
  // segment vertex is projected to screen space for drawing. Levels come
  // straight from the palette's own stops so they line up with the fill.
  // ---------------------------------------------------------------------
  function computeContourSegments(grid, levels) {
    const segments = []; // [{level, a:{lat,lon}, b:{lat,lon}}]
    const at = (row, col) => grid.data[row * grid.nx + col];
    const missing = (row, col) => grid.isNoData[row * grid.nx + col] === 1;

    for (let row = 0; row < grid.ny - 1; row++) {
      for (let col = 0; col < grid.nx - 1; col++) {
        if (missing(row, col) || missing(row + 1, col) || missing(row, col + 1) || missing(row + 1, col + 1)) continue;

        const v00 = at(row, col), v10 = at(row, col + 1);
        const v01 = at(row + 1, col), v11 = at(row + 1, col + 1);
        const lon0 = grid.lons[col], lon1 = grid.lons[col + 1];
        const lat0 = grid.lats[row], lat1 = grid.lats[row + 1];

        for (const level of levels) {
          const corners = [v00 > level, v10 > level, v11 > level, v01 > level];
          const caseIdx = (corners[0] ? 1 : 0) | (corners[1] ? 2 : 0) | (corners[2] ? 4 : 0) | (corners[3] ? 8 : 0);
          if (caseIdx === 0 || caseIdx === 15) continue; // fully above or below — no crossing

          const lerp = (va, vb, pa, pb) => pa + ((level - va) / (vb - va)) * (pb - pa);
          // Edge midpoint interpolations (top/right/bottom/left of this cell)
          const top = { lat: lat0, lon: lerp(v00, v10, lon0, lon1) };
          const right = { lat: lerp(v10, v11, lat0, lat1), lon: lon1 };
          const bottom = { lat: lat1, lon: lerp(v01, v11, lon0, lon1) };
          const left = { lat: lerp(v00, v01, lat0, lat1), lon: lon0 };

          // Standard marching-squares edge table (ambiguous saddle cases
          // 5/10 resolved by picking one consistent diagonal — fine for a
          // visual reference overlay, not a scientific contouring tool).
          const EDGE_PAIRS = {
            1: [left, top], 2: [top, right], 3: [left, right],
            4: [right, bottom], 5: [left, top, right, bottom], // saddle
            6: [top, bottom], 7: [left, bottom],
            8: [bottom, left], 9: [top, bottom],
            10: [top, left, bottom, right], // saddle
            11: [right, bottom], 12: [left, right],
            13: [top, right], 14: [left, top],
          };
          const pts = EDGE_PAIRS[caseIdx];
          if (!pts) continue;
          for (let i = 0; i < pts.length; i += 2) {
            segments.push({ level, a: pts[i], b: pts[i + 1] });
          }
        }
      }
    }
    return segments;
  }

  function renderContours(canvas, grid, latLngToContainerPointFn, levels) {
    const ctx = canvas.getContext("2d");
    const segments = computeContourSegments(grid, levels);

    ctx.strokeStyle = "rgba(20, 20, 20, 0.55)";
    ctx.lineWidth = 1;
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.fillStyle = "rgba(20, 20, 20, 0.85)";

    let labelCounter = 0;
    for (const seg of segments) {
      const p1 = latLngToContainerPointFn(seg.a.lat, seg.a.lon);
      const p2 = latLngToContainerPointFn(seg.b.lat, seg.b.lon);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      // Label roughly every 40th segment so the map doesn't get cluttered.
      labelCounter++;
      if (labelCounter % 40 === 0) {
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        ctx.fillText(String(Math.round(seg.level)), midX + 3, midY - 3);
      }
    }
  }

  return {
    isSupported: (kind) => Object.prototype.hasOwnProperty.call(FIELD_RECIPES, kind),
    loadFieldGrid,
    renderFill,
    renderContours,
  };
})();
