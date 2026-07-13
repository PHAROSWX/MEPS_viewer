#!/usr/bin/env python3
"""
fetch_meps.py — pulls a small subset of the current MEPS "latest" run and
saves it into data/ for the repo to self-archive. Designed to run from the
GitHub Actions workflow in .github/workflows/fetch-meps.yml on a schedule.

v2 — fixes a real bug from v1: the request had no time constraint at all,
so NCSS was being asked for every one of the ~65 forecast steps across the
full grid for 5 variables in one go. That's plausibly what tripped the
503s — either a server-side timeout on a genuinely huge request, or a
load-shedding/anti-abuse layer reacting to it. Two changes address this:

  1. TIME_MODE=present by default — NCSS's special `time=present` value asks
     for just the single time step nearest now, instead of the whole run.
     Set MEPS_TIME_MODE=all as an env var if you deliberately want every
     forecast hour (expect a much bigger, slower request).
  2. A bounding box (BBOX below) constrains the pull to a region instead of
     the entire Nordic/Baltic/UK domain. Adjust to taste.

Still true from v1: I have NOT been able to test this against the live
server (built without network access to thredds.met.no). If it keeps
failing after this change, read the printed response body — it'll usually
say whether this is a real timeout, a bad parameter, or a bot-challenge
page, which point to different fixes.
"""

import datetime
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Same candidate list as config.js — keep these in sync if you change one.
CANDIDATE_WMS_ENDPOINTS = [
    "https://thredds.met.no/thredds/wms/meps25epsfiles/meps_det_2_5km_latest.nc",
    "https://thredds.met.no/thredds/wms/meps25files/meps_det_pp_2_5km_latest.nc",
]

# Keep this list short — every extra variable adds to file size.
VARIABLES = [
    "air_temperature_2m",
    "precipitation_amount",
    "x_wind_10m",
    "y_wind_10m",
    "air_pressure_at_sea_level",
]

# "present" = just the time step nearest now (small, fast). "all" = every
# forecast hour in the aggregation (large, slow — mainly useful for a
# separate, less-frequent archival job). Override with env var MEPS_TIME_MODE.
TIME_MODE = os.environ.get("MEPS_TIME_MODE", "present")

# Rough bounding box (lon/lat) to keep the pull small — default covers
# mainland Norway/Sweden/Finland. Widen if you need the Baltics/UK too.
# Set MEPS_BBOX="west,south,east,north" to override, or MEPS_BBOX=none to
# request the full domain (only sensible combined with TIME_MODE=present).
DEFAULT_BBOX = (4.0, 57.0, 32.0, 71.5)  # west, south, east, north

RETRIES = 3
RETRY_BACKOFF_SECONDS = 10

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "meps_latest.nc")
OUTPUT_META = os.path.join(OUTPUT_DIR, "meps_latest.meta.json")

HEADERS = {
    # A generic browser-shaped UA + Accept header — some services 503/403
    # scripted requests that look too bot-like. If MET Norway's server
    # doesn't care, this is harmless either way.
    "User-Agent": "Mozilla/5.0 (compatible; meps-viewer-fetch-script/2.0; +https://github.com/)",
    "Accept": "*/*",
}


def wms_to_ncss(wms_url: str) -> str:
    """THREDDS convention: .../thredds/wms/<path> <-> .../thredds/ncss/grid/<path>"""
    if "/thredds/wms/" not in wms_url:
        raise ValueError(f"unexpected WMS URL shape, can't derive NCSS: {wms_url}")
    return wms_url.replace("/thredds/wms/", "/thredds/ncss/grid/")


def build_params() -> dict:
    params = {
        "var": ",".join(VARIABLES),
        "accept": "netcdf",
    }
    if TIME_MODE == "present":
        params["time"] = "present"
    elif TIME_MODE != "all":
        raise ValueError(f"unknown MEPS_TIME_MODE={TIME_MODE!r}, expected 'present' or 'all'")

    bbox_env = os.environ.get("MEPS_BBOX")
    bbox = None if bbox_env == "none" else (
        tuple(float(x) for x in bbox_env.split(",")) if bbox_env else DEFAULT_BBOX
    )
    if bbox:
        west, south, east, north = bbox
        params.update({
            "west": west, "south": south, "east": east, "north": north,
        })
    return params


def try_fetch(wms_url: str) -> bytes:
    ncss_base = wms_to_ncss(wms_url)
    url = ncss_base + "?" + urllib.parse.urlencode(build_params())
    print(f"Fetching: {url}")

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
                break  # not a transient error, no point retrying
        except urllib.error.URLError as e:
            print(f"  attempt {attempt}/{RETRIES}: {e.reason}", file=sys.stderr)
            last_exc = RuntimeError(str(e.reason))
        if attempt < RETRIES:
            time.sleep(RETRY_BACKOFF_SECONDS * attempt)
    raise last_exc


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    last_err = None
    for endpoint in CANDIDATE_WMS_ENDPOINTS:
        try:
            data = try_fetch(endpoint)
            if len(data) < 1024:
                raise RuntimeError(
                    f"suspiciously small response ({len(data)} bytes) — likely an error page, not NetCDF: "
                    f"{data[:300]!r}"
                )
            with open(OUTPUT_FILE, "wb") as f:
                f.write(data)
            with open(OUTPUT_META, "w") as f:
                f.write(
                    '{"source": "%s", "fetched_at": "%s", "size_bytes": %d, "time_mode": "%s", "variables": %s}\n'
                    % (endpoint, datetime.datetime.utcnow().isoformat() + "Z", len(data), TIME_MODE, VARIABLES)
                )
            print(f"OK — wrote {OUTPUT_FILE} ({len(data)} bytes) from {endpoint}")
            return 0
        except Exception as e:
            print(f"Failed against {endpoint}: {e}", file=sys.stderr)
            last_err = e

    print(f"All candidate endpoints failed. Last error: {last_err}", file=sys.stderr)
    print(
        "If the error body above looks like an HTML challenge/JS page rather than an XML/text error, "
        "that's an anti-bot layer, not a URL problem — needs a different fetch strategy (e.g. from a "
        "residential IP or with a real browser), not just a header tweak.\n"
        "If it's a THREDDS/ncWMS-style error message about the dataset or variable names, adjust "
        "VARIABLES or CANDIDATE_WMS_ENDPOINTS accordingly.\n"
        "See README.md troubleshooting section for more.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
