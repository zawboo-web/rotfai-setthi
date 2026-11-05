"""เอาตำแหน่งกระดานตามภูมิศาสตร์ (จาก Unity gamedata.json ที่ผ่าน geo_layout.py แล้ว) มาใส่เวอร์ชันเว็บ
สร้างบล็อก JS: GEO_POS, ป้ายชื่อเมือง (ซ้าย/ขวา/บน/ล่าง เลือกอัตโนมัติ), เส้นขอบประเทศไทย และเขต 6 ภาค
ใช้: python3 tools/geo_web.py <unity gamedata.json> <thailand_ne50m.json> rotfai.html
"""
import json, math, sys, re
GD, RINGS, HTML = sys.argv[1:4]
g = json.load(open(GD, encoding="utf-8")); L = g["layout"]
N = {n["id"]: n for n in g["nodes"]}
rings = json.load(open(RINGS))["rings"]
def proj(lon, lat): return ((lon - L["lon0"]) * L["kx"] + L["offset"], (L["lat0"] - lat) * L["ky"] + L["offset"])
def simp(pts, tol=1.2):            # ตัดจุดที่ห่างกันน้อยกว่า tol
    out = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) >= tol: out.append(p)
    return out
def path(poly): return "M" + "L".join("%.1f %.1f" % p for p in poly) + "Z"
thai = [simp([proj(lon, lat) for lon, lat in r]) for r in rings]
thai = [r for r in thai if len(r) >= 3]
REGION_POLY = {
    "n": [(97.0, 20.8), (101.7, 20.8), (101.3, 18.2), (101.1, 17.6), (101.6, 16.8), (101.5, 15.3), (99.2, 15.3), (99.0, 16.8), (99.2, 17.6), (98.5, 17.5), (97.0, 17.9)],
    "ne": [(101.3, 18.2), (106.0, 18.6), (106.0, 14.1), (101.4, 14.1), (101.5, 15.3), (101.6, 16.8), (101.1, 17.6)],
    "e": [(100.85, 14.25), (101.4, 14.1), (103.8, 14.1), (103.8, 11.3), (100.85, 11.3)],
    "w": [(97.0, 17.9), (98.5, 17.5), (99.2, 17.6), (99.0, 16.8), (99.2, 15.3), (99.85, 14.3), (100.1, 13.4), (100.25, 12.5), (100.25, 10.9), (97.0, 10.9)],
    "s": [(97.0, 10.9), (103.0, 10.9), (103.0, 5.0), (97.0, 5.0)],
}
regions = {k: path([proj(*p) for p in v]) for k, v in REGION_POLY.items()}
allp = [p for r in thai for p in r]
X0, Y0 = math.floor(min(p[0] for p in allp)) - 14, math.floor(min(p[1] for p in allp)) - 16
W, H = math.ceil(max(p[0] for p in allp)) + 14 - X0, math.ceil(max(p[1] for p in allp)) + 14 - Y0

html = open(HTML, encoding="utf-8").read()
names = dict(re.findall(r'(\b[A-Z]{3})\s*:\s*\{\s*th\s*:\s*"([^"]+)"', html))
pos = {k: (round(n["x"], 1), round(n["y"], 1)) for k, n in N.items() if "_o" not in k}
stations = [k for k, n in N.items() if n.get("name") and n["name"].get("th")]
islands = {k for k, n in N.items() if n.get("island")}

# ---- เลือกด้านป้ายชื่อ: ชนช่อง/เส้นทาง/ป้ายอื่นน้อยที่สุด (ชอบซ้าย-ขวามากกว่าบน-ล่าง) ----
segs = [(pos[e["a"]], pos[e["b"]]) for e in g["edges"] if e["a"] in pos and e["b"] in pos]
def seg_hits_box(a, b, bx):
    for t in [i / 8 for i in range(9)]:
        x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
        if bx[0] < x < bx[2] and bx[1] < y < bx[3]: return True
    return False
def box(k, side):
    x, y = pos[k]; w = len(names.get(k, N[k]["name"]["th"])) * 3.0 + 4
    if side == "R": return (x + 6, y - 5, x + 9 + w, y + 8)
    if side == "L": return (x - 9 - w, y - 5, x - 6, y + 8)
    if side == "U": return (x - w / 2, y - 16, x + w / 2, y - 6)
    return (x - w / 2, y + 6, x + w / 2, y + 18)
placed = []; side_of = {}
for k in sorted(stations, key=lambda s: -sum(1 for o in pos if math.hypot(pos[o][0] - pos[s][0], pos[o][1] - pos[s][1]) < 30)):
    best, bs = None, 1e9
    for side, pen in (("R", 0), ("L", 0.5), ("U", 3), ("D", 3.5)):
        b = box(k, side); sc = pen
        if b[0] < X0 + 2 or b[2] > X0 + W - 2: sc += 50
        for o, p in pos.items():
            if o != k and b[0] - 3 < p[0] < b[2] + 3 and b[1] - 3 < p[1] < b[3] + 3: sc += 6
        for a, c in segs:
            if pos[k] not in (a, c) and seg_hits_box(a, c, b): sc += 3
        for q in placed:
            if not (b[2] < q[0] or b[0] > q[2] or b[3] < q[1] or b[1] > q[3]): sc += 10
        if sc < bs: bs, best = sc, side
    side_of[k] = best; placed.append(box(k, best))

out = {
    "pos": pos, "view": [X0, Y0, W, H],
    "R": sorted(k for k, s in side_of.items() if s == "R"),
    "U": sorted(k for k, s in side_of.items() if s == "U"),
    "D": sorted(k for k, s in side_of.items() if s == "D"),
    "thai": "".join(path(r) for r in thai), "regions": regions,
    "labels": {k: [round(v[0]), round(v[1])] for k, v in {
        "n": proj(98.6, 19.9), "ne": proj(103.6, 14.55), "c": proj(99.75, 15.05), "e": proj(102.3, 13.2), "w": proj(98.7, 16.3), "s": proj(100.4, 10.3)}.items()},
}
block = "// ===== กระดานตามภูมิศาสตร์จริง (สร้างจาก tools/geo_web.py · ตำแหน่งเดียวกับเวอร์ชัน Unity) =====\nconst GEO=" + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
block += "for(const k in GEO.pos) if(NODES[k]){NODES[k].x=GEO.pos[k][0];NODES[k].y=GEO.pos[k][1];}\n"
block += "LABEL_R.clear();GEO.R.forEach(k=>LABEL_R.add(k));LABEL_UP.clear();GEO.U.forEach(k=>LABEL_UP.add(k));LABEL_DN.clear();GEO.D.forEach(k=>LABEL_DN.add(k));\n"
block += "const VB=GEO.view;   // x y w h ของกระดาน\n"
START, END = "// ===== กระดานตามภูมิศาสตร์จริง", "const VB=GEO.view;   // x y w h ของกระดาน\n"
if START in html:
    i = html.index(START); j = html.index(END, i) + len(END); html = html[:i] + block + html[j:]
else:
    anchor = "// ===== ซอยวนรอบเมือง"; i = html.index(anchor); html = html[:i] + block + html[i:]
open(HTML, "w", encoding="utf-8").write(html)
print("view", out["view"], "labels R/L/U/D", len(out["R"]), sum(1 for s in side_of.values() if s == "L"), len(out["U"]), len(out["D"]), "block", len(block), "bytes")
