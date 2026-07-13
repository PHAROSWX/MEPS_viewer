#!/usr/bin/env python3
"""
fetch_meps.py — pulls a small subset of the current MEPS "latest" run and
saves it into data/ for the repo to self-archive. Designed to run from the
GitHub Actions workflow in .github/workflows/fetch-meps.yml on a schedule.

Why a subset and not the full file: MEPS's full deterministic file has many
variables, ~65 forecast hours, at full 2.5 km resolution across the whole
Nordic domain — hundreds of MB to a few GB. Committing that to git on a
schedule would blow up repo size fast. This script asks THREDDS's NetCDF
Subset Service (NCSS) for just a handful of named variables, which is
normally a few MB.

I have NOT been able to test this against the live server (this repo was
built in a sandboxed environment without network access to thredds.met.no)
— the query structure follows THREDDS/NCSS conventions, but if MET Norway's
NCSS is configured differently you may need to adjust VARIABLES or the URL
derivation below. Run it locally first (`python3 scripts/fetch_meps.py`)
before trusting the scheduled workflow.
"""

import datetime
import os
import sys
import urllib.request
import urllib.parse

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

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "meps_latest.nc")
OUTPUT_META = os.path.join(OUTPUT_DIR, "meps_latest.meta.json")


def wms_to_ncss(wms_url: str) -> str:
    """THREDDS convention: .../thredds/wms/<path> <-> .../thredds/ncss/grid/<path>"""
    if "/thredds/wms/" not in wms_url:
        raise ValueError(f"unexpected WMS URL shape, can't derive NCSS: {wms_url}")
    return wms_url.replace("/thredds/wms/", "/thredds/ncss/grid/")


def try_fetch(wms_url: str) -> bytes:
    ncss_base = wms_to_ncss(wms_url)
    params = {
        "var": ",".join(VARIABLES),
        "accept": "netcdf",
    }
    url = ncss_base + "?" + urllib.parse.urlencode(params)
    print(f"Fetching: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "meps-viewer-fetch-script/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status}")
        return resp.read()


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    last_err = None
    for endpoint in CANDIDATE_WMS_ENDPOINTS:
        try:
            data = try_fetch(endpoint)
            if len(data) < 1024:
                raise RuntimeError(f"suspiciously small response ({len(data)} bytes) — likely an error page, not NetCDF")
            with open(OUTPUT_FILE, "wb") as f:
                f.write(data)
            with open(OUTPUT_META, "w") as f:
                f.write(
                    '{"source": "%s", "fetched_at": "%s", "size_bytes": %d, "variables": %s}\n'
                    % (endpoint, datetime.datetime.utcnow().isoformat() + "Z", len(data), VARIABLES)
                )
            print(f"OK — wrote {OUTPUT_FILE} ({len(data)} bytes) from {endpoint}")
            return 0
        except Exception as e:
            print(f"Failed against {endpoint}: {e}", file=sys.stderr)
            last_err = e

    print(f"All candidate endpoints failed. Last error: {last_err}", file=sys.stderr)
    print("MET Norway may have moved their NCSS/WMS layout — see README.md troubleshooting section.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
