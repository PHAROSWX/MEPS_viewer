// palettes.js
// -----------------------------------------------------------------------------
// Color ramps extracted directly from the user-supplied QGIS .qml style files
// (temperature_color_table.qml, cape_color_table.qml, snow_color_table2.qml).
// Each stop is [value, hexColor]; render() linearly interpolates between the
// two nearest stops, same as QGIS's "INTERPOLATED" colorrampshader mode.
//
// wind_color.qml was NOT included here — it's a categorized *vector* style
// (buckets "5% / 15% / 30% / 45% / 60%" with fill colors), not a continuous
// m/s ramp, so it doesn't map onto a wind-speed gradient the way the other
// three do. If you can tell me what those buckets represent (gust risk?
// probability of >X m/s?) I can wire up a matching discrete legend instead.

const METAR_PALETTES = {
  temperature: {
    unit: "°C",
    stops: [
      [-40, "#ff6eff"], [-35, "#e522de"], [-30, "#960ca3"], [-25, "#64007f"],
      [-20, "#32007f"], [-15, "#00528f"], [-10, "#259aff"], [-5, "#9ad0ff"],
      [-1, "#d9ecff"], [1, "#b1f1d6"], [5, "#07a127"], [10, "#52ca0b"],
      [15, "#e6f702"], [20, "#f4a20b"], [25, "#f4520b"], [30, "#8c0000"],
      [31, "#780000"], [32, "#640000"], [33, "#8c3232"], [34, "#b46464"],
      [35, "#f0a0a0"], [40, "#ffdcdc"], [45, "#c5c5c5"], [50, "#8a8a8a"],
    ],
  },

  cape: {
    unit: "J/kg",
    stops: [
      [0, "#1e7800"], [20, "#449900"], [40, "#68ac06"], [100, "#8cc00d"],
      [200, "#b1d414"], [300, "#d5e81b"], [400, "#fafc22"], [600, "#fad024"],
      [800, "#faa427"], [1000, "#fb7929"], [1200, "#fb4d2c"], [1400, "#fc222f"],
      [1600, "#fc2256"], [1800, "#fc227e"], [2000, "#fc22a6"], [2200, "#fc22ce"],
      [2400, "#fc22f6"], [2800, "#fc41f7"], [3200, "#fc61f8"], [3600, "#fd80f9"],
      [4000, "#fda0fb"], [4500, "#febffc"], [5000, "#fedffd"],
    ],
  },

  // NOTE: this ramp is identical in range/shape to a temperature ramp
  // (-40..50), just finer-grained. The source file's embedded layer name
  // was literally "night" (night.tif), which doesn't read as snow either.
  // Wiring it up under the "snow" key for now, but flag this to the user —
  // it may need a real snow-depth/accumulation ramp (typically 0..a few
  // hundred cm) instead.
  snow: {
    unit: "°C (unverified — see note in palettes.js)",
    stops: [
      [-40, "#ff6eff"], [-38, "#ff46f8"], [-36, "#f627eb"], [-35, "#e522de"],
      [-33, "#d41dd1"], [-30, "#c318c4"], [-29, "#b414b9"], [-28, "#a510ae"],
      [-27, "#960ca3"], [-26, "#870898"], [-25, "#78048d"], [-24, "#64007f"],
      [-23, "#57007f"], [-22, "#4b007f"], [-21, "#3e007f"], [-20, "#32007f"],
      [-19, "#00287f"], [-18, "#00327f"], [-17, "#003c7f"], [-16, "#00467f"],
      [-15, "#00528f"], [-14, "#0062af"], [-13, "#0072cf"], [-12, "#0082ef"],
      [-11, "#1392ff"], [-10, "#259aff"], [-9, "#49acff"], [-8, "#5bb4ff"],
      [-7, "#6dbcff"], [-6, "#7fc4ff"], [-5, "#91ccff"], [-4, "#9ad0ff"],
      [-3, "#a3d4ff"], [-2, "#b5dcff"], [-1, "#c7e4ff"], [0, "#d9ecff"],
      [1, "#b1f1d6"], [2, "#95dfbc"], [3, "#87d3ab"], [4, "#62af88"],
      [5, "#4a9775"], [6, "#07a127"], [7, "#08b30f"], [8, "#21bb0e"],
      [9, "#39c20c"], [10, "#52ca0b"], [11, "#84d908"], [12, "#9ce106"],
      [13, "#b5e805"], [14, "#cef003"], [15, "#e6f702"], [16, "#f3fb01"],
      [17, "#ebe816"], [18, "#f4d90b"], [19, "#f4cb0b"], [20, "#f4bd0b"],
      [21, "#f4a20b"], [22, "#f4880b"], [23, "#f47a0b"], [24, "#f46d0b"],
      [25, "#f4520b"], [26, "#e83709"], [27, "#dc2708"], [28, "#c41a0a"],
      [29, "#ba130f"], [30, "#af0f14"], [31, "#8c0000"], [32, "#780000"],
      [33, "#640000"], [34, "#8c3232"], [35, "#b46464"], [36, "#c87878"],
      [37, "#f0a0a0"], [38, "#ffb4b4"], [39, "#ffc8c8"], [40, "#ffdcdc"],
      [42, "#fff0f0"], [44, "#e2e2e2"], [45, "#c5c5c5"], [47, "#a8a8a8"],
      [49, "#8a8a8a"], [50, "#6d6d6d"],
    ],
  },
};

// Which of our field "kind"s (see PREFERRED_FIELDS in config.js) has a
// matching custom palette here.
const PALETTE_BY_KIND = {
  temperature: "temperature",
  cape: "cape",
  snow: "snow",
  // "wind" and others intentionally omitted — see note above.
};

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

// Interpolate a color for `value` within a palette's stops (clamped at ends).
function paletteColorAt(paletteName, value) {
  const p = METAR_PALETTES[paletteName];
  if (!p) return null;
  const stops = p.stops;
  if (value <= stops[0][0]) return stops[0][1];
  if (value >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [v0, c0] = stops[i];
    const [v1, c1] = stops[i + 1];
    if (value >= v0 && value <= v1) {
      const t = (value - v0) / (v1 - v0);
      const [r0, g0, b0] = hexToRgb(c0);
      const [r1, g1, b1] = hexToRgb(c1);
      return rgbToHex(r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t);
    }
  }
  return stops[stops.length - 1][1];
}

// Render a palette as a vertical gradient bar into an existing <canvas>,
// with tick labels drawn to its right. Mirrors the QGIS "continuous legend"
// look from the source .qml files.
function renderPaletteLegend(canvas, paletteName) {
  const p = METAR_PALETTES[paletteName];
  if (!p) return false;
  const stops = p.stops;
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const barW = 22;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  stops.forEach(([v, color]) => {
    const t = 1 - (v - min) / (max - min); // top = max value
    grad.addColorStop(Math.min(1, Math.max(0, t)), color);
  });
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, barW, h);
  ctx.strokeStyle = "rgba(27,36,48,0.4)";
  ctx.strokeRect(0, 0, barW, h);

  ctx.fillStyle = "#1b2430";
  ctx.font = "10px 'IBM Plex Mono', monospace";
  ctx.textBaseline = "middle";
  const labelCount = 5;
  for (let i = 0; i < labelCount; i++) {
    const t = i / (labelCount - 1);
    const v = max - t * (max - min);
    const y = t * h;
    ctx.fillText(Math.round(v).toString(), barW + 6, Math.min(Math.max(y, 6), h - 6));
  }
  return true;
}
