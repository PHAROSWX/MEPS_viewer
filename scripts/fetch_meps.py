#!/usr/bin/env python3
"""
fetch_meps.py — pulls a small subset of the current MEPS run and saves it
into data/ for the repo to self-archive. Designed to run from the GitHub
Actions workflow in .github/workflows/fetch-meps.yml on a schedule.

v3 — switched primary source to FMI (Finnish Meteorological Institute)'s
open data Download Service, which mirrors the same MetCoOp MEPS/Harmonie
run MET Norway serves, at http://opendata.fmi.fi/download. Reasons:

  - Plain GET requests with documented, stable query parameters — no
    THREDDS NCSS path-guessing (.../wms/<path> vs .../ncss/grid/<path>),
    which was a real source of fragility in earlier versions.
  - No API key / registration required (FMI dropped that requirement
    in 2019 — see https://en.ilmatieteenlaitos.fi/news/963113482).
  - No 503s observed in testing (MET Norway's THREDDS gave 503 on every
    attempt when this was tried in July 2026).

MET Norway's THREDDS/NCSS is kept as a fallback (fetch_from_thredds below)
in case FMI's service is ever the one that's unavailable.

Docs: https://en.ilmatieteenlaitos.fi/open-data-manual-forecast-models

I still have NOT been able to test this against the live server myself —
built without network access to either opendata.fmi.fi or thredds.met.no.
Run it locally first before trusting the schedule:

    python3 scripts/fetch_meps.py
"""

import datetime
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
OUTPUT_BASENAME = "meps_latest"
OUTPUT_META = os.path.join(OUTPUT_DIR, OUTPUT_BASENAME + ".meta.json")

RETRIES = 3
RETRY_BACKOFF_SECONDS = 10

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; meps-viewer-fetch-script/3.0; +https://github.com/)",
    "Accept": "*/*",
}

# ---------------------------------------------------------------------------
# Primary: FMI open data Download Service
# ---------------------------------------------------------------------------

FMI_DOWNLOAD_URL = "https://opendata.fmi.fi/download"

# "harmonie_scandinavia_surface" is FMI's producer id for the MEPS/Harmonie
# surface-level run over the Scandinavia domain (same underlying MetCoOp
# model MET Norway serves as "meps").
FMI_PRODUCER = "harmonie_scandinavia_surface"

# FMI's officially-documented parameter names (note: PascalCase, not the
# CF-style names MET Norway uses). CAPE and TotalCloudCover showed up in
# FMI's own example WFS response too, alongside the shorter "supported"
# list in their manual, so both are included here — drop CAPE if FMI
# rejects it for this producer.
FMI_VARIABLES = [
    "Temperature",       # deg C already (FMI, unlike MET Norway's raw NetCDF, returns this pre-converted)
    "Pressure",          # hPa (also pre-converted — check the output; adjust CF_UNIT_CONVERSIONS in config.js if not)
    "WindUMS",
    "WindVMS",
    "Precipitation1h",
    "TotalCloudCover",
    "CAPE",
]

# Rough bounding box (lon/lat) — mainland Norway/Sweden/Finland. Widen if
# you need the Baltics/UK too. Set MEPS_BBOX env var to override, or "none"
# for FMI's full domain.
DEFAULT_BBOX = (4.0, 57.0, 32.0, 71.5)  # west, south, east, north

# Small forecast window by default (12 hourly steps) rather than the full
# ~65h run — keeps the request light. Override with MEPS_TIMESTEPS.
DEFAULT_TIMESTEPS = 12
DEFAULT_TIMESTEP_MINUTES = 60

# v3 first attempt used format=netcdf at native ~2.5km resolution over the
# whole bbox above — that came back as 257 MB, well past GitHub's 100 MB
# hard file-size limit (this repo isn't using Git LFS, and a growing binary
# blob on every hourly commit would be a bad idea even if it were). Two
# changes fix the actual size problem instead of reaching for LFS:
#
#   1. format=grib2 instead of netcdf — GRIB2 is a packed/compressed format,
#      typically 5-10x smaller than raw NetCDF floats for the same data.
#   2. gridresolution — explicitly downsamples the grid (native MEPS
#      resolution is 2.5km; this requests 5km, a 4x reduction in point
#      count) rather than shipping every native grid cell for an archival
#      snapshot that doesn't need full resolution.
#
# Rough sizing at these defaults: ~270 x 320 grid points x 12 timesteps x
# 7 variables x ~2 bytes packed ≈ 15 MB — comfortable headroom under 100 MB.
# Override with MEPS_GRIDRESOLUTION_KM if you want native-resolution data
# for a smaller area instead.
DEFAULT_GRIDRESOLUTION_KM = 5.0

# Hard safety cap: if FMI ever returns something much bigger than expected
# (e.g. a future parameter change re-inflates the response), fail loudly
# and don't write/commit a file that would just get rejected by GitHub's
# push anyway. Comfortably under the 100 MB hard limit.
MAX_OUTPUT_BYTES = 60 * 1024 * 1024


def fetch_from_fmi() -> bytes:
    bbox_env = os.environ.get("MEPS_BBOX")
    bbox = None if bbox_env == "none" else (
        tuple(float(x) for x in bbox_env.split(",")) if bbox_env else DEFAULT_BBOX
    )
    gridres = os.environ.get("MEPS_GRIDRESOLUTION_KM", str(DEFAULT_GRIDRESOLUTION_KM))
    params = {
        "producer": FMI_PRODUCER,
        "param": ",".join(FMI_VARIABLES),
        "format": "grib2",
        "projection": "EPSG:4326",
        "timestep": os.environ.get("MEPS_TIMESTEP_MINUTES", str(DEFAULT_TIMESTEP_MINUTES)),
        "timesteps": os.environ.get("MEPS_TIMESTEPS", str(DEFAULT_TIMESTEPS)),
        "gridresolution": f"{gridres},{gridres}",
    }
    if bbox:
        params["bbox"] = ",".join(str(v) for v in bbox)

    url = FMI_DOWNLOAD_URL + "?" + urllib.parse.urlencode(params)
    print(f"Fetching (FMI): {url}")
    return _get_with_retries(url)


# ---------------------------------------------------------------------------
# Fallback: MET Norway THREDDS NCSS (kept from earlier versions)
# ---------------------------------------------------------------------------

THREDDS_CANDIDATE_ENDPOINTS = [
    "https://thredds.met.no/thredds/wms/meps25epsfiles/meps_det_2_5km_latest.nc",
    "https://thredds.met.no/thredds/wms/meps25files/meps_det_pp_2_5km_latest.nc",
]
THREDDS_VARIABLES = [
    "air_temperature_2m",
    "precipitation_amount",
    "x_wind_10m",
    "y_wind_10m",
    "air_pressure_at_sea_level",
]


def wms_to_ncss(wms_url: str) -> str:
    if "/thredds/wms/" not in wms_url:
        raise ValueError(f"unexpected WMS URL shape, can't derive NCSS: {wms_url}")
    return wms_url.replace("/thredds/wms/", "/thredds/ncss/grid/")


def fetch_from_thredds() -> bytes:
    bbox_env = os.environ.get("MEPS_BBOX")
    bbox = None if bbox_env == "none" else (
        tuple(float(x) for x in bbox_env.split(",")) if bbox_env else DEFAULT_BBOX
    )
    last_exc = None
    for endpoint in THREDDS_CANDIDATE_ENDPOINTS:
        try:
            ncss_base = wms_to_ncss(endpoint)
            params = {"var": ",".join(THREDDS_VARIABLES), "accept": "netcdf", "time": "present"}
            if bbox:
                west, south, east, north = bbox
                params.update({"west": west, "south": south, "east": east, "north": north})
            url = ncss_base + "?" + urllib.parse.urlencode(params)
            print(f"Fetching (THREDDS fallback): {url}")
            return _get_with_retries(url)
        except Exception as e:
            print(f"  THREDDS candidate failed: {endpoint}: {e}", file=sys.stderr)
            last_exc = e
    raise last_exc


# ---------------------------------------------------------------------------
# Shared HTTP helper
# ---------------------------------------------------------------------------

def _get_with_retries(url: str) -> bytes:
    last_exc = None
    for attempt in range(1, RETRIES + 1):
        req = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            body = e.read(1000).decode("utf-8", errors="replace")
            print(f"  attempt {attempt}/{RETRIES}: HTTP {e.code} — body starts: {body[:300]!r}", file=sys.stderr)
            last_exc = RuntimeError(f"HTTP {e.code}: {body[:300]}")
            if e.code not in (502, 503, 504):
                break
        except urllib.error.URLError as e:
            print(f"  attempt {attempt}/{RETRIES}: {e.reason}", file=sys.stderr)
            last_exc = RuntimeError(str(e.reason))
        if attempt < RETRIES:
            time.sleep(RETRY_BACKOFF_SECONDS * attempt)
    raise last_exc


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    source_used = None
    data = None
    file_ext = None
    try:
        data = fetch_from_fmi()
        source_used = "fmi:" + FMI_PRODUCER
        file_ext = ".grib2"
    except Exception as e:
        print(f"FMI fetch failed: {e}", file=sys.stderr)
        print("Falling back to MET Norway THREDDS...", file=sys.stderr)
        try:
            data = fetch_from_thredds()
            source_used = "met.no thredds"
            file_ext = ".nc"
        except Exception as e2:
            print(f"THREDDS fallback also failed: {e2}", file=sys.stderr)
            print(
                "Both sources failed. If the response body logged above looks like an HTML "
                "challenge/JS page rather than a real service error, that's an anti-bot layer, "
                "not a URL problem. See README.md troubleshooting section.",
                file=sys.stderr,
            )
            return 1

    if len(data) < 1024:
        print(f"Suspiciously small response ({len(data)} bytes) — likely an error page, not real data: "
              f"{data[:300]!r}", file=sys.stderr)
        return 1

    if len(data) > MAX_OUTPUT_BYTES:
        print(
            f"Response is {len(data) / 1024 / 1024:.1f} MB, over the {MAX_OUTPUT_BYTES / 1024 / 1024:.0f} MB "
            f"safety cap (GitHub's hard limit is 100 MB). Not writing/committing this file — it would just "
            f"fail at push time anyway. Shrink MEPS_TIMESTEPS, widen MEPS_GRIDRESOLUTION_KM, or narrow "
            f"MEPS_BBOX and try again.",
            file=sys.stderr,
        )
        return 1

    output_file = os.path.join(OUTPUT_DIR, OUTPUT_BASENAME + file_ext)
    # Clean up a stale file from a previous run in the *other* format, so
    # the repo doesn't accumulate both meps_latest.nc and meps_latest.grib2
    # if the source ever switches between runs.
    for other_ext in (".nc", ".grib2"):
        if other_ext != file_ext:
            stale = os.path.join(OUTPUT_DIR, OUTPUT_BASENAME + other_ext)
            if os.path.exists(stale):
                os.remove(stale)

    with open(output_file, "wb") as f:
        f.write(data)
    with open(OUTPUT_META, "w") as f:
        f.write(
            '{"source": "%s", "fetched_at": "%s", "size_bytes": %d, "file": "%s"}\n'
            % (source_used, datetime.datetime.now(datetime.timezone.utc).isoformat(), len(data),
               OUTPUT_BASENAME + file_ext)
        )
    print(f"OK — wrote {output_file} ({len(data)} bytes) from {source_used}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
