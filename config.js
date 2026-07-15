// config.js
// -----------------------------------------------------------------------------
// MET Norway has changed the exact WMS host for MEPS a few times over the
// years (thredds.met.no -> fastapi.s-enda.k8s.met.no -> ogc-wms-from-netcdf.k8s.met.no,
// plus a couple of differently-named "latest" aggregation files). Rather than
// hard-coding one URL and breaking silently, this file lists a primary
// endpoint plus fallbacks. app.js tries them in order at startup and lets you
// override/reload from the "Source" panel in the UI without editing code.
//
// If all of these are stale by the time you read this: open
// https://thredds.met.no/thredds/catalog/meps25epsfiles/catalog.html in a
// browser, find the current "...latest.nc" file, then build the WMS
// GetCapabilities URL as:
//   https://thredds.met.no/thredds/wms/<path-to-file>?service=WMS&version=1.3.0&request=GetCapabilities
// and paste it into the Source box in the app (or update CANDIDATE_ENDPOINTS below).

const MEPS_CONFIG = {
  CANDIDATE_ENDPOINTS: [
    // Deterministic control run, continuously-updated aggregation (preferred: stable name, always current)
    "https://thredds.met.no/thredds/wms/meps25epsfiles/meps_det_2_5km_latest.nc",
    "https://thredds.met.no/thredds/wms/meps25files/meps_det_pp_2_5km_latest.nc",
    // Nordic 1km post-processed product (broader coverage, different variable set)
    "https://thredds.met.no/thredds/wms/metpplatest/met_forecast_1_0km_nordic_latest.nc",
  ],

  // Preferred variables to surface first if present in GetCapabilities, in this order.
  // Matching is done against WMS layer Name/Title (case-insensitive substring match).
  // `unit` here is a DISPLAY DEFAULT ONLY — app.js overrides it with whatever
  // unit the server actually reports (via ncWMS layerDetails) whenever it can,
  // and applies the CF_UNIT_CONVERSIONS below to turn raw server units (Pa, K)
  // into human-friendly ones (hPa, °C). Don't rely on this field being correct
  // on its own.
  PREFERRED_FIELDS: [
    { match: ["air_temperature_2m", "temperature"], label: "Temperature · 2m", unit: "°C", kind: "temperature" },
    { match: ["precipitation_amount_acc", "precipitation_amount", "precipitation"], label: "Precipitation", unit: "mm", kind: "precip" },
    { match: ["wind_speed_of_gust", "wind_gust"], label: "Wind gusts · 1h", unit: "m/s", kind: "wind" },
    { match: ["wind_speed", "x_wind", "wind"], label: "Wind speed · 10m", unit: "m/s", kind: "wind" },
    { match: ["cloud_area_fraction", "cloud"], label: "Cloud cover", unit: "%", kind: "cloud" },
    { match: ["air_pressure_at_sea_level", "surface_air_pressure", "pressure"], label: "Mean sea level pressure", unit: "hPa", kind: "pressure" },
    { match: ["relative_humidity"], label: "Relative humidity · 2m", unit: "%", kind: "humidity" },
    { match: ["specific_convective_available_potential_energy", "convective_available_potential_energy"], label: "CAPE", unit: "J/kg", kind: "cape" },
    { match: ["surface_snow_thickness", "snow_depth"], label: "Snow depth", unit: "cm", kind: "snow" },
  ],

  // Well-known CF unit conversions, applied automatically when the server
  // reports one of these source units. This is what fixes the "102309.2 hPa"
  // (actually Pa) and equivalent Kelvin-vs-Celsius bugs.
  CF_UNIT_CONVERSIONS: {
    Pa:  { to: "hPa", fn: (v) => v / 100 },
    K:   { to: "°C",  fn: (v) => v - 273.15 },
    "1": { to: "%",   fn: (v) => v * 100 },   // fractions (e.g. cloud_area_fraction 0-1)
  },

  // Rough physical plausibility ranges per field "kind", used only to flag
  // (not hide) a GetFeatureInfo reading that looks wrong — e.g. a unit or
  // layer mismatch on the server side — rather than presenting it silently
  // as fact.
  SANITY_RANGES: {
    temperature: [-90, 60],   // °C
    pressure: [850, 1100],    // hPa
    wind: [0, 120],           // m/s
    humidity: [0, 100],       // %
    cloud: [0, 100],          // %
    cape: [0, 8000],          // J/kg
    precip: [0, 500],         // mm
    snow: [0, 600],            // cm — real snow-depth range now that the palette is fixed
  },

  MAP_CENTER: [64.5, 17.0], // roughly the geographic middle of the MEPS domain (Norway/Sweden/Finland)
  MAP_ZOOM: 5,
  MAP_MIN_ZOOM: 3,
  MAP_MAX_ZOOM: 10,
};
