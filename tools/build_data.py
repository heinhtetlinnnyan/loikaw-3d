"""Build data/loikaw.json from raw downloads.

Inputs (in the folder given as argv[1]):
  osm.json      Overpass API result (out geom tags) for the bbox below
  ms_bbox.json  Microsoft building footprints clipped to the bbox, optional
  terr/X_Y.png  AWS Terrarium elevation tiles, zoom 14

Coordinates are converted to local metres around ORIGIN:
  x = east, z = south (three.js convention), y = up.
"""
import json, math, os, sys

import numpy as np
from PIL import Image

SRC = sys.argv[1]
OUT = sys.argv[2]
S, W, N, E = 19.63, 97.17, 19.72, 97.25
LAT0, LON0 = 19.675, 97.21
MX = 111320 * math.cos(math.radians(LAT0))
MZ = 110540
Z = 14


def xz(lat, lon):
    return round((lon - LON0) * MX, 1), round(-(lat - LAT0) * MZ, 1)


def flat(coords):
    out = []
    for lat, lon in coords:
        x, z = xz(lat, lon)
        out += [x, z]
    return out


# ---------- terrain ----------
def tile_xy(lat, lon):
    n = 2 ** Z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


tx0, ty0 = tile_xy(N, W)
tx1, ty1 = tile_xy(S, E)
ix0, iy0, ix1, iy1 = int(tx0), int(ty0), int(tx1), int(ty1)
mosaic = np.zeros(((iy1 - iy0 + 1) * 256, (ix1 - ix0 + 1) * 256), dtype=np.float32)
for ty in range(iy0, iy1 + 1):
    for tx in range(ix0, ix1 + 1):
        a = np.asarray(Image.open(f"{SRC}/terr/{tx}_{ty}.png").convert("RGB"), dtype=np.float32)
        h = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
        mosaic[(ty - iy0) * 256:(ty - iy0 + 1) * 256, (tx - ix0) * 256:(tx - ix0 + 1) * 256] = h

# resample onto a regular grid in local metres
x_min, z_min = xz(N, W)
x_max, z_max = xz(S, E)
STEP = 25.0
gw = int((x_max - x_min) / STEP) + 1
gh = int((z_max - z_min) / STEP) + 1
grid = np.zeros((gh, gw), dtype=np.float32)
for j in range(gh):
    lat = LAT0 - (z_min + j * STEP) / MZ
    for i in range(gw):
        lon = LON0 + (x_min + i * STEP) / MX
        fx, fy = tile_xy(lat, lon)
        px = (fx - ix0) * 256 - 0.5
        py = (fy - iy0) * 256 - 0.5
        x0, y0 = int(px), int(py)
        dx, dy = px - x0, py - y0
        m = mosaic
        grid[j, i] = (m[y0, x0] * (1 - dx) * (1 - dy) + m[y0, x0 + 1] * dx * (1 - dy)
                      + m[y0 + 1, x0] * (1 - dx) * dy + m[y0 + 1, x0 + 1] * dx * dy)
base = float(np.floor(grid.min()))
terrain = {
    "x0": x_min, "z0": z_min, "step": STEP, "w": gw, "h": gh, "base": base,
    "d": [int(round((v - base) * 10)) for v in grid.flatten()],  # decimetres above base
}

# ---------- OSM ----------
osm = json.load(open(f"{SRC}/osm.json"))["elements"]
roads, buildings, water_lines, water_areas, green, places = [], [], [], [], [], []
GREEN = {"grass", "meadow", "forest", "park", "pitch", "golf_course", "recreation_ground",
         "farmland", "orchard", "village_green", "stadium", "sports_centre"}


def geom(e):
    return [(p["lat"], p["lon"]) for p in e.get("geometry", []) if p]


def bheight(t):
    try:
        if "height" in t:
            return float(str(t["height"]).split()[0])
        if "building:levels" in t:
            return float(t["building:levels"]) * 3.2
    except ValueError:
        pass
    return {"stadium": 10, "grandstand": 8, "hospital": 9, "school": 7, "university": 9,
            "church": 12, "train_station": 7}.get(t.get("building"), 0)


for e in osm:
    t = e.get("tags", {})
    if e["type"] == "node":
        name = t.get("name:en") or t.get("name")
        if name:
            x, z = xz(e["lat"], e["lon"])
            kind = t.get("place") or t.get("amenity") or t.get("tourism") or t.get("railway") or "poi"
            if kind in ("artwork",):
                continue
            places.append({"n": name, "my": t.get("name") if t.get("name:en") else None,
                           "k": kind, "x": x, "z": z})
        continue
    g = geom(e)
    if len(g) < 2:
        continue
    if "building" in t:
        if g[0] != g[-1]:
            continue
        buildings.append({"p": flat(g[:-1]), "h": bheight(t), "s": "osm",
                          "n": t.get("name:en") or t.get("name"), "k": t.get("building")})
    elif "highway" in t:
        roads.append({"t": t["highway"], "n": t.get("name:en") or t.get("name"), "p": flat(g)})
    elif "waterway" in t and t["waterway"] in ("river", "stream", "canal", "drain", "ditch"):
        water_lines.append({"t": t["waterway"], "n": t.get("name:en") or t.get("name"), "p": flat(g)})
    elif t.get("natural") == "water" and g[0] == g[-1]:
        water_areas.append({"n": t.get("name:en") or t.get("name"), "p": flat(g[:-1])})
    elif (t.get("landuse") in GREEN or t.get("leisure") in GREEN) and g[0] == g[-1]:
        green.append({"p": flat(g[:-1])})

# ---------- Microsoft Building Footprints (satellite-derived) ----------
# ms_bbox.json: GeoJSON features from Microsoft GlobalMLBuildingFootprints,
# quadkey 132201032, already clipped to the bbox by centroid.
n_ms = 0
ms_path = f"{SRC}/ms_bbox.json"


def inside(x, z, p):
    ins = False
    j = len(p) - 2
    for i in range(0, len(p), 2):
        xi, zi, xj, zj = p[i], p[i + 1], p[j], p[j + 1]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            ins = not ins
        j = i
    return ins


osm_boxes = [(min(b["p"][0::2]), max(b["p"][0::2]), min(b["p"][1::2]), max(b["p"][1::2]), b["p"]) for b in buildings]
if os.path.exists(ms_path):
    for f in json.load(open(ms_path)):
        ring = f["geometry"]["coordinates"][0]
        g = [(lat, lon) for lon, lat in ring]
        if len(g) < 4:
            continue
        p = flat(g[:-1])
        cx, cz = sum(p[0::2]) / (len(p) / 2), sum(p[1::2]) / (len(p) / 2)
        if any(x0 <= cx <= x1 and z0 <= cz <= z1 and inside(cx, cz, q) for x0, x1, z0, z1, q in osm_boxes):
            continue  # already mapped in OSM
        h = f["properties"].get("height", -1)
        buildings.append({"p": p, "h": round(h, 1) if h and h > 0 else 0, "s": "ms"})
        n_ms += 1

data = {
    "origin": [LAT0, LON0], "bbox": [S, W, N, E],
    "terrain": terrain, "roads": roads, "buildings": buildings,
    "waterLines": water_lines, "waterAreas": water_areas, "green": green, "places": places,
}
json.dump(data, open(OUT, "w"), separators=(",", ":"), ensure_ascii=False)
print(f"terrain {gw}x{gh} base {base} m, range {grid.max() - base:.0f} m")
print(f"roads {len(roads)}, buildings {len(buildings)} (microsoft {n_ms}), "
      f"water {len(water_lines)}+{len(water_areas)}, green {len(green)}, places {len(places)}")
print(f"size {os.path.getsize(OUT) / 1e6:.2f} MB")
