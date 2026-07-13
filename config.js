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
  PREFERRED_FIELDS: [
    { match: ["air_temperature_2m", "temperature"], label: "Temperature · 2m", unit: "°C", kind: "temperature" },
    { match: ["precipitation_amount_acc", "precipitation_amount", "precipitation"], label: "Precipitation", unit: "mm", kind: "precip" },
    { match: ["wind_speed", "x_wind", "wind"], label: "Wind speed · 10m", unit: "m/s", kind: "wind" },
    { match: ["cloud_area_fraction", "cloud"], label: "Cloud cover", unit: "%", kind: "cloud" },
    { match: ["air_pressure_at_sea_level", "surface_air_pressure", "pressure"], label: "Mean sea level pressure", unit: "hPa", kind: "pressure" },
    { match: ["relative_humidity"], label: "Relative humidity · 2m", unit: "%", kind: "humidity" },
  ],

  MAP_CENTER: [64.5, 17.0], // roughly the geographic middle of the MEPS domain (Norway/Sweden/Finland)
  MAP_ZOOM: 5,
  MAP_MIN_ZOOM: 3,
  MAP_MAX_ZOOM: 10,
};
