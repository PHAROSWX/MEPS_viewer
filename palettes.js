// palettes.js
// -----------------------------------------------------------------------------
// Color ramps for the map legend. Two different sources feed this file:
//
//   - temperature, cape: hand-authored QGIS .qml color ramps
//     (temperature_color_table.qml, cape_color_table.qml), parsed exactly.
//   - gusts, precip, mslp, cloud, snow: pixel-sampled from reference legend
//     screenshots (see the palette-extraction note further down).
//
// Each stop is [value, hexColor]; render() linearly interpolates between the
// two nearest stops, same as QGIS's "INTERPOLATED" colorrampshader mode.
//
// wind_color.qml was NOT used for the wind palette below — it's a
// categorized *vector* style (buckets "5% / 15% / 30% / 45% / 60%" with fill
// colors), not a continuous m/s ramp, so it doesn't map onto a wind-speed
// gradient the way the others do. "wind" instead uses the gusts palette
// (see PALETTE_BY_KIND below), sourced from a real wind-gusts legend. If you
// can tell me what those wind_color.qml buckets represent (gust risk?
// probability of >X m/s?) I can still wire up a matching discrete overlay.

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

  // Wind gusts, 1h (m/s). Pixel-sampled from a reference legend image and
  // matched to its printed tick labels — see palette-extraction note at the
  // bottom of this file. Also used for the "wind" field kind, since we don't
  // have a separate sustained-wind-speed reference ramp; gusts and sustained
  // speed share units and a similar visual range, but if you get a proper
  // wind_speed-specific ramp later, split this out.
  gusts: {
    unit: "m/s",
    stops: [
      [1.5, "#707f7f"], [4, "#5a787d"], [7, "#3c5c7d"], [10, "#28527a"],
      [13, "#1e4b7a"], [16, "#0f5a0f"], [19, "#1b691e"], [22, "#287828"],
      [25, "#4b7a46"], [28, "#7f7d55"], [31, "#7f743c"], [34, "#7f601e"],
      [37, "#7f3000"], [40, "#7a1900"], [43, "#700a00"], [46, "#520000"],
      [49, "#54005d"], [52, "#761d7f"], [55, "#7f7f7f"], [58, "#7d7873"],
      [61, "#786e69"], [64, "#705f5a"], [67, "#5a4641"], [70, "#503c37"],
      [73, "#46322d"], [75, "#321e19"], [90, "#321e19"], // 90 = flat "off-scale" cap color beyond 75
    ],
  },

  // Precipitation, 1h (mm). Same source/method as gusts above.
  precip: {
    unit: "mm",
    stops: [
      [0.1, "#787878"], [0.2, "#5a6b7f"], [0.5, "#3a5d7f"], [1, "#1a4d7f"],
      [2, "#02417f"], [3, "#003469"], [4, "#001b3f"], [5, "#0a470d"],
      [6, "#0d6702"], [7, "#317603"], [8, "#7f7a15"], [9, "#746e00"],
      [10, "#783000"], [12, "#7f5335"], [14, "#7c273c"], [16, "#7b0f2a"],
      [20, "#5f0000"], [24, "#440000"], [30, "#32003f"], [40, "#61007d"],
      [50, "#6e337f"], [60, "#75537f"], [80, "#7c737f"], [100, "#6a6a6a"],
      [125, "#4b4b4b"],
    ],
  },

  // Mean sea level pressure (hPa). Same source/method as gusts above.
  mslp: {
    unit: "hPa",
    stops: [
      [900, "#7f237c"], [915, "#6a0e68"], [930, "#520857"], [942, "#43044c"],
      [954, "#2b003f"], [966, "#00143f"], [974, "#002947"], [980, "#09497f"],
      [986, "#48667f"], [992, "#58786b"], [998, "#315744"], [1004, "#045907"],
      [1010, "#296505"], [1016, "#677801"], [1022, "#7a6505"], [1028, "#7a4a05"],
      [1034, "#741b04"], [1040, "#460000"], [1046, "#5a3232"], [1052, "#785050"],
      [1058, "#7f6e6e"], [1062, "#626262"],
    ],
  },

  // Total cloud cover (%). Same source/method as gusts above.
  cloud: {
    unit: "%",
    stops: [
      [1, "#ecd905"], [10, "#dac909"], [20, "#c7b80e"], [30, "#b4a712"],
      [40, "#a29617"], [50, "#8f861b"], [60, "#7d7520"], [70, "#6a6424"],
      [80, "#575329"], [90, "#45432d"], [99, "#323232"],
    ],
  },

  // Snow depth (cm) — replaces the earlier placeholder that was flagged as
  // likely mislabeled (a temperature-shaped ramp under a "night.tif" name in
  // its source .qml). This one is a real snow-depth reference legend.
  snow: {
    unit: "cm",
    stops: [
      [0.1, "#dcdcfa"], [0.5, "#aaaac8"], [1, "#75baff"], [2, "#359aff"],
      [3, "#0482ff"], [4, "#0069d2"], [5, "#004f9d"], [7, "#00327f"],
      [10, "#4b007f"], [15, "#64007f"], [20, "#9100bb"], [30, "#c200fb"],
      [40, "#d135ff"], [50, "#eba6ff"], [60, "#f4ceff"], [70, "#fab2cb"],
      [80, "#ff9697"], [100, "#ff6e6e"], [150, "#df093f"], [200, "#bf0000"],
      [250, "#a40000"], [300, "#880000"], [400, "#460000"],
    ],
  },
};

// -----------------------------------------------------------------------------
// Palette-extraction note (gusts/precip/mslp/cloud/snow): these five were
// pixel-sampled from reference legend screenshots (a color bar image + its
// printed tick labels), not hand-authored .qml files like temperature/cape.
// Method: locate the horizontal gradient bar in the image, walk it pixel by
// pixel to find distinct color blocks, then match those blocks to the
// printed tick values in left-to-right order (resampling if the pixel-block
// count and tick-label count didn't match exactly, which happens when a bar
// is rendered with more/finer color steps than it has printed labels for).
// CAPE was cross-checked against the independently-sourced cape_color_table
// .qml file and matched exactly, which is a good sanity check on the method
// — but treat these five as a close, verified-where-possible approximation
// of the source legend rather than a pixel-perfect reproduction.

// Which of our field "kind"s (see PREFERRED_FIELDS in config.js) has a
// matching custom palette here.
const PALETTE_BY_KIND = {
  temperature: "temperature",
  cape: "cape",
  snow: "snow",
  wind: "gusts",
  precip: "precip",
  pressure: "mslp",
  cloud: "cloud",
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
