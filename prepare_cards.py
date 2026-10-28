#!/usr/bin/env python3
"""แปลงภาพการ์ดจาก ComfyUI ให้พร้อมใส่ในเกม

ใช้:  python prepare_cards.py "C:/ComfyUI/output/rotfai_cards"
ได้:  โฟลเดอร์ cards/ ข้างสคริปต์นี้ มีไฟล์ P01.webp, D01.webp, ... ขนาด 720x960
      จากนั้นลากไฟล์ทั้งหมดใน cards/ ไปวางในโฟลเดอร์ cards ของ repo บนเว็บ GitHub

ถ้ามีหลายไฟล์รหัสเดียวกัน (เช่น card_P01_00001_.png, card_P01_00002_.png) จะใช้ไฟล์ล่าสุด
ต้องมี Pillow:  pip install pillow
"""
import re, sys
from pathlib import Path
try:
    from PIL import Image
except ImportError:
    sys.exit("ต้องติดตั้ง Pillow ก่อน: pip install pillow")

if len(sys.argv) < 2:
    sys.exit('ใส่โฟลเดอร์ภาพด้วย เช่น  python prepare_cards.py "C:/ComfyUI/output/rotfai_cards"')
src = Path(sys.argv[1])
out = Path(__file__).resolve().parent / "cards"
out.mkdir(exist_ok=True)
pat = re.compile(r"card_([PDIGE]\d{2})", re.I)
latest = {}
for f in src.iterdir():
    m = pat.search(f.name)
    if m and f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
        cid = m.group(1).upper()
        if cid not in latest or f.stat().st_mtime > latest[cid].stat().st_mtime:
            latest[cid] = f
W, H = 720, 960
for cid, f in sorted(latest.items()):
    im = Image.open(f).convert("RGB")
    s = max(W / im.width, H / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    l, t = (im.width - W) // 2, (im.height - H) // 2
    im.crop((l, t, l + W, t + H)).save(out / f"{cid}.webp", "WEBP", quality=86)
print(f"แปลงแล้ว {len(latest)} ภาพ → {out}")
