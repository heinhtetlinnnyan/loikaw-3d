# Loikaw 3D

Walk, cycle, ride a motorbike or fly around Loikaw (လွိုင်ကော်), Kayah State, Myanmar, in your browser.

**Play:** https://heinhtetlinnnyan.github.io/loikaw-3d/

## Controls

| | |
|---|---|
| `W A S D` / arrows | move (bicycle and motorbike: W go, S brake, A/D steer) |
| mouse | look (click the scene to capture the mouse) |
| `Shift` | run / pedal harder / open the throttle / fly faster |
| `Space` | jump (walk) · climb (fly) |
| `C` | descend (fly) |
| `1` `2` `3` `4` | walk · bicycle · motorbike · fly |
| `F` | take off / land on the bicycle or motorbike (then Space/C or look up/down to climb) |
| `L` | Thadingyut festival lights on/off (on by default during the festival) |
| `T` | let time run (one hour every 30 seconds) · `[` `]` an hour back/forward |
| `M` | bigger map; click the map to jump there |

On a phone: joystick bottom-left, drag anywhere to look.

## Where the data comes from

- **Streets, rivers, lakes, named places, ~240 buildings**: [OpenStreetMap](https://www.openstreetmap.org/copyright), © OpenStreetMap contributors, ODbL.
- **~23,000 more building outlines**: [Microsoft Global ML Building Footprints](https://github.com/microsoft/GlobalMLBuildingFootprints), traced from satellite imagery, ODbL. These have no height information, so heights are estimated (mostly one or two storeys).
- **Terrain**: [Mapzen / AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (SRTM-based, ~30 m).

**Hand-made models**, placed at their real locations and shaped after photos on [Wikimedia Commons (Category:Loikaw)](https://commons.wikimedia.org/wiki/Category:Loikaw); the shapes are approximations, not surveys:
- **Taung Kwe Pagoda** (19.6675° N, 97.2081° E): the flat-topped crag, main stupa, smaller stupas and the lift tower with its tiered roof.
- **Myo Nan Pagoda / မြို့နာမ်စေတီ** (19.6778° N, 97.2113° E): a gilded stupa on the platform traced from satellite imagery. No photos were found, so the stupa is a typical Burmese design, not its real shape.
- **Clock Tower / နာရီစင်** (19.6772° N, 97.2120° E): the striped tower on its roundabout. Its clock shows the game's time. This is where you start.

**Buildings** get painted facades (plaster houses, shophouses along the main roads, teak houses, concrete blocks) and hipped tin roofs in the blue, green, red and grey seen around town. These are typical styles, not the real look of each building.

**Thadingyut**: candles in front of homes, paper lanterns along the main streets, and strings of lights on the pagoda and clock tower, under a full moon.

Satellite imagery and OSM edits come from different years, so some buildings may no longer stand, or may be missing.

## Make it better

The best way to improve this map is to improve OpenStreetMap: add buildings, names, pagodas, schools and `building:levels` tags around Loikaw at [openstreetmap.org](https://www.openstreetmap.org/#map=15/19.675/97.21), then rebuild the data.

## Rebuilding the data

`tools/build_data.py` turns raw downloads into `data/loikaw.json`. It needs Python with `numpy` and `pillow`, and a folder containing:

- `osm.json`: an Overpass API result (`out geom tags`) for ways tagged `building`, `highway`, `waterway`, `natural=water`, `landuse`, `leisure`, plus named nodes, in bbox `19.63,97.17,19.72,97.25`
- `ms_bbox.json`: Microsoft footprints for quadkey `132201032`, filtered to the bbox
- `terr/X_Y.png`: Terrarium tiles at zoom 14, x 12614–12617, y 7276–7280

```bash
python tools/build_data.py path/to/downloads data/loikaw.json
```

Serve the folder with any static server (`python -m http.server`) and open it.

Built with [three.js](https://threejs.org).
