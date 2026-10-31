#!/usr/bin/env python3
"""ตุ๊กตุ๊กเศรษฐีไทย · เจนภาพการ์ดด้วย OpenAI (gpt-image) จากไฟล์พรอมป์ชุดเดียวกับ ComfyUI

ตั้ง API key ครั้งเดียว (เปิดหน้าต่าง cmd ใหม่หลังตั้ง):
  setx OPENAI_API_KEY "sk-..."

ดูก่อนว่าจะเจนอะไรบ้าง (ไม่เสียเงิน):
  python queue_openai.py --dry-run --have "C:\\rotfai-setthi\\cards"

1) เจนทันทีทีละใบ
  python queue_openai.py --only P01,P02 --quality low           ลองถูกๆ ก่อน
  python queue_openai.py --sheet กิจการ --have cards              ข้ามใบที่มีภาพในโฟลเดอร์ cards แล้ว
  python queue_openai.py --only P74-P145 --ref style\\P01.png,style\\G08.png
        --ref = ภาพตัวอย่างสไตล์ (1–4 ภาพ) ให้ทุกใบออกมาลายเส้นเดียวกัน

2) Batch (ถูกกว่าราวครึ่ง ได้ผลภายใน 24 ชม. ใช้ --ref ไม่ได้)
  python queue_openai.py batch-submit --have cards
  python queue_openai.py batch-status
  python queue_openai.py batch-fetch

3) แก้ภาพที่มีอยู่ (เปลี่ยนชุด/พร็อพ แต่หน้าตาตัวละครเหมือนเดิม)
  python queue_openai.py edit A01_full.png "Remove the conductor cap ..." --name A01_full_v2

ตัวเลือกอื่น
  --out openai_cards       โฟลเดอร์เก็บภาพ (ค่าเริ่มต้น ข้างสคริปต์)
  --model gpt-image-2      เปลี่ยนรุ่นได้ เช่น gpt-image-1
  --quality low|medium|high
  --force                  เจนทับไฟล์ที่มีอยู่แล้วในโฟลเดอร์ --out
  --budget 8               หยุดเองเมื่อใช้เงินถึง $8 (ประมาณการจากข้อมูลที่ OpenAI ส่งกลับ)
  การ์ดที่พรอมป์ขึ้นต้นด้วย "This is an RGBA image..." (มินิเกม) จะสั่งพื้นหลังใสให้อัตโนมัติ
ใช้แค่ Python มาตรฐาน ไม่ต้องลงอะไรเพิ่ม
"""
import argparse, base64, json, mimetypes, os, re, sys, time, urllib.request, urllib.error, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
API = "https://api.openai.com/v1"
RGBA_PREFIX = "This is an RGBA image with transparency. The background is transparent. "
STATE = HERE / ".openai_batch.json"
STYLE_NOTE = ("Use the attached reference image(s) only as a guide for art style: line weight, colouring, shading, "
              "palette and level of detail. Do not copy their characters or composition. Draw this new subject: ")


GH = bool(os.environ.get("GITHUB_ACTIONS"))


def fail(msg):
    """จบพร้อมข้อความ · บน GitHub Actions ให้ขึ้นเป็นกล่องแดงในหน้าผลงานด้วย"""
    if GH:
        print("::error::" + msg.replace("\n", " · "))
    sys.exit(msg)


def done_ok(msg):
    if GH:
        print("::notice::" + msg)
    print(msg); sys.exit(0)


def key():
    k = os.environ.get("OPENAI_API_KEY")
    if not k:
        fail("ยังไม่ได้ตั้ง OPENAI_API_KEY  ให้พิมพ์  setx OPENAI_API_KEY \"sk-...\"  แล้วเปิด cmd ใหม่")
    return k


def call(method, path, body=None, raw=None, ctype="application/json", timeout=600):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {key()}", "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        b = r.read()
        return b if path.endswith("/content") else json.loads(b.decode())


def multipart(fields, files):
    """fields: {name: value}, files: [(fieldname, Path)]"""
    bnd = uuid.uuid4().hex
    out = b""
    for k, v in fields.items():
        out += f"--{bnd}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    for name, fp in files:
        ct = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        out += (f"--{bnd}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{Path(fp).name}\"\r\n"
                f"Content-Type: {ct}\r\n\r\n").encode() + Path(fp).read_bytes() + b"\r\n"
    out += f"--{bnd}--\r\n".encode()
    return out, f"multipart/form-data; boundary={bnd}"


def parse_only(s):
    want = set()
    for x in s.upper().replace(" ", "").split(","):
        if "-" in x:
            lo, hi = x.split("-", 1)
            pre = re.match(r"[A-Z]+", lo).group(0)
            for n in range(int(lo[len(pre):]), int(hi.lstrip(pre)) + 1):
                want.add(f"{pre}{n:02d}")
        elif x:
            want.add(x)
    return want


def have_ids(dirs):
    got = set()
    for d in dirs or []:
        p = Path(d)
        if not p.exists():
            print("ไม่เจอโฟลเดอร์", p)
            continue
        for f in p.iterdir():
            m = re.search(r"(?<![A-Z])([PDIGEATMU]\d{2,3})(?!\d)", f.stem.upper())
            if m and f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
                got.add(m.group(1))
    return got


def pick_cards(a):
    cards = json.load(open(a.cards, encoding="utf-8"))["cards"]
    if a.only:
        want = parse_only(a.only)
        cards = [c for c in cards if c["id"].upper() in want]
    if a.sheet:
        cards = [c for c in cards if c["sheet"] == a.sheet]
    if a.skip:
        skip = parse_only(a.skip)
        cards = [c for c in cards if c["id"].upper() not in skip]
    if a.done and Path(a.done).exists():
        donelist = {x.strip().upper() for x in Path(a.done).read_text(encoding="utf-8").split() if x.strip()}
        cards = [c for c in cards if c["id"].upper() not in donelist]
    got = have_ids(a.have)
    if got:
        before = len(cards)
        cards = [c for c in cards if c["id"].upper() not in got]
        print(f"ข้ามใบที่มีภาพแล้ว {before - len(cards)} ใบ")
    if not cards:
        done_ok("ไม่มีการ์ดให้เจน: ใบที่เลือกเจนไปแล้วทั้งหมด หรือ ID/แท็บไม่ตรง (ถ้าจะเจนทับ ให้ติ๊ก force)")
    return cards


def request_body(c, a):
    p = c["prompt"]
    transparent = p.startswith(RGBA_PREFIX)
    if transparent:
        p = p[len(RGBA_PREFIX):]
    w, h = c.get("width", 1536), c.get("height", 2048)
    size = "1024x1024" if w == h else ("1024x1536" if h > w else "1536x1024")
    body = {"model": a.model, "prompt": p, "size": size, "quality": a.quality, "n": 1, "output_format": "png"}
    if transparent:
        body["background"] = "transparent"
    return body


def out_dir(a):
    d = Path(a.out)
    if not d.is_absolute():
        d = HERE / d
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_b64(path, b64):
    path.write_bytes(base64.b64decode(b64))


def gen_one(body, refs):
    """เจน 1 ภาพ · มีภาพอ้างอิงสไตล์ → ใช้ /images/edits"""
    if not refs:
        r = call("POST", "/images/generations", body)
    else:
        fields = {k: v for k, v in body.items() if k != "prompt"}
        fields["prompt"] = STYLE_NOTE + body["prompt"]
        raw, ct = multipart(fields, [("image[]", r) for r in refs])
        r = call("POST", "/images/edits", raw=raw, ctype=ct)
    return r["data"][0]["b64_json"], est_cost(r.get("usage") or {})


def est_cost(u):
    """ประมาณค่าใช้จ่ายจาก usage ที่ OpenAI ส่งกลับ (ราคา gpt-image-2: รูปเข้า $8, ข้อความ $5, รูปออก $30 ต่อล้านโทเคน)"""
    d = u.get("input_tokens_details") or {}
    img, txt = d.get("image_tokens", 0), d.get("text_tokens", u.get("input_tokens", 0) - d.get("image_tokens", 0))
    return (img * 8 + txt * 5 + u.get("output_tokens", 0) * 30) / 1e6


def with_retry(label, fn):
    for attempt in range(5):
        try:
            return fn()
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:500]
            if e.code in (429, 500, 502, 503) and attempt < 4:
                wait = 20 * (attempt + 1)
                print(f"  {label} ติด {e.code} รอ {wait} วิแล้วลองใหม่")
                time.sleep(wait)
                continue
            if e.code == 400 and ("safety" in msg.lower() or "moderation" in msg.lower()):
                print(f"  {label} ✗ โดนตัวกรองเนื้อหา ข้ามไปก่อน (ลองแก้พรอมป์): {msg[:200]}")
                return None
            if e.code == 403 and "verif" in msg.lower():
                fail("OpenAI ให้ยืนยันองค์กรก่อนใช้โมเดลภาพ: platform.openai.com → Settings → Organization → Verify")
            fail(f"OpenAI ปฏิเสธ {label}: {e.code}\n{msg}")
        except urllib.error.URLError as e:
            if attempt < 4:
                time.sleep(10)
                continue
            fail(f"ต่อ OpenAI ไม่ได้: {e}")


def run_direct(a):
    cards = pick_cards(a)
    od = out_dir(a)
    todo = [c for c in cards if a.force or not (od / f"card_{c['id']}.png").exists()]
    refs = [Path(r.strip()) for r in a.ref.split(",")] if a.ref else []
    for r in refs:
        if not r.exists():
            fail(f"ไม่เจอภาพอ้างอิง {r}")
    print(f"ต้องเจน {len(todo)} ใบ · {a.model} · quality {a.quality}" + (f" · อ้างอิงสไตล์ {len(refs)} ภาพ" if refs else ""))
    if a.dry_run:
        for c in todo:
            b = request_body(c, a)
            print("[dry-run]", c["id"], c["sheet"], b["size"], "พื้นใส" if "background" in b else "")
        return
    done, spent = 0, 0.0
    for i, c in enumerate(todo, 1):
        res = with_retry(c["id"], lambda: gen_one(request_body(c, a), refs))
        if res:
            b64, cost = res
            save_b64(od / f"card_{c['id']}.png", b64)
            done += 1; spent += cost
            if a.done:
                with open(a.done, "a", encoding="utf-8") as fh: fh.write(c["id"] + "\n")
            print(f"[{i}/{len(todo)}] {c['id']} ✓  ~${cost:.3f} · รวม ~${spent:.2f}")
            if a.budget and spent >= a.budget:
                print(f"\nถึงงบ ${a.budget} แล้ว หยุดก่อน (รันคำสั่งเดิมอีกครั้งเพื่อทำต่อ)"); break
    print(f"\nเสร็จ {done} ใบ · ประมาณ ${spent:.2f} · ภาพอยู่ที่ {od}")


def run_edit(a):
    src = Path(a.image)
    if not src.exists():
        fail(f"ไม่เจอภาพ {src}")
    fields = {"model": a.model, "prompt": a.prompt, "quality": a.quality, "n": "1", "output_format": "png"}
    if a.size:
        fields["size"] = a.size
    if a.transparent:
        fields["background"] = "transparent"
    files = [("image[]", src)] + [("image[]", Path(r.strip())) for r in (a.ref.split(",") if a.ref else [])]
    if a.dry_run:
        print("[dry-run] แก้", src, "→", a.prompt[:120]); return
    raw, ct = multipart(fields, files)
    b64 = with_retry(src.name, lambda: call("POST", "/images/edits", raw=raw, ctype=ct)["data"][0]["b64_json"])
    if b64:
        dst = out_dir(a) / f"{a.name or src.stem + '_edit'}.png"
        save_b64(dst, b64)
        print("บันทึกแล้ว", dst)


def batch_submit(a):
    cards = pick_cards(a)
    od = out_dir(a)
    todo = [c for c in cards if a.force or not (od / f"card_{c['id']}.png").exists()]
    lines = [json.dumps({"custom_id": c["id"], "method": "POST", "url": "/v1/images/generations",
                         "body": request_body(c, a)}, ensure_ascii=False) for c in todo]
    print(f"เตรียม batch {len(todo)} ใบ · {a.model} · quality {a.quality}")
    if a.dry_run:
        print(", ".join(c["id"] for c in todo)); return
    tmp = HERE / "rotfai_batch.jsonl"
    tmp.write_text("\n".join(lines), encoding="utf-8")
    raw, ct = multipart({"purpose": "batch"}, [("file", tmp)])
    f = call("POST", "/files", raw=raw, ctype=ct)
    b = call("POST", "/batches", {"input_file_id": f["id"], "endpoint": "/v1/images/generations", "completion_window": "24h"})
    STATE.write_text(json.dumps({"batch_id": b["id"], "out": a.out, "count": len(todo)}))
    print("ส่งแล้ว batch id:", b["id"], "\nเช็กสถานะ: python queue_openai.py batch-status")


def batch_id(a):
    if a.batch:
        return a.batch
    if not STATE.exists():
        fail("ไม่เจอ batch ล่าสุด ใส่ --batch batch_xxx")
    return json.loads(STATE.read_text())["batch_id"]


def batch_status(a):
    b = call("GET", f"/batches/{batch_id(a)}")
    rc = b.get("request_counts") or {}
    print(f"{b['id']} · สถานะ {b['status']} · เสร็จ {rc.get('completed', 0)}/{rc.get('total', '?')} · พลาด {rc.get('failed', 0)}")
    return b


def batch_fetch(a):
    b = batch_status(a)
    if b["status"] != "completed":
        fail("ยังไม่เสร็จ ลองใหม่ทีหลัง")
    od, n = out_dir(a), 0
    if b.get("output_file_id"):
        for line in call("GET", f"/files/{b['output_file_id']}/content").decode().splitlines():
            r = json.loads(line)
            try:
                save_b64(od / f"card_{r['custom_id']}.png", r["response"]["body"]["data"][0]["b64_json"]); n += 1
            except (KeyError, TypeError):
                print("  ", r.get("custom_id"), "ไม่มีภาพ:", str(r.get("error") or r.get("response"))[:200])
    if b.get("error_file_id"):
        for line in call("GET", f"/files/{b['error_file_id']}/content").decode().splitlines():
            r = json.loads(line)
            print("  ✗", r.get("custom_id"), str(r.get("error") or r.get("response", {}).get("body"))[:200])
    print(f"บันทึก {n} ภาพที่ {od}")


def main():
    ap = argparse.ArgumentParser(description="เจนการ์ดด้วย OpenAI gpt-image")
    ap.add_argument("cmd", nargs="?", default="run", choices=["run", "edit", "batch-submit", "batch-status", "batch-fetch"])
    ap.add_argument("image", nargs="?", help="(edit) ภาพที่จะแก้")
    ap.add_argument("prompt", nargs="?", help="(edit) สั่งว่าจะแก้อะไร")
    ap.add_argument("--cards", default=str(HERE / "rotfai-cards-prompts.json"))
    ap.add_argument("--only"); ap.add_argument("--sheet"); ap.add_argument("--skip", help="ID ที่ไม่เอา เช่น G01-G11,A01-A08")
    ap.add_argument("--have", action="append", help="โฟลเดอร์ภาพที่มีอยู่แล้ว (ใส่ซ้ำได้หลายโฟลเดอร์)")
    ap.add_argument("--ref", help="ภาพอ้างอิงสไตล์ คั่นด้วยจุลภาค")
    ap.add_argument("--model", default="gpt-image-2")
    ap.add_argument("--quality", default="medium", choices=["low", "medium", "high", "auto"])
    ap.add_argument("--out", default="openai_cards")
    ap.add_argument("--name", help="(edit) ชื่อไฟล์ผลลัพธ์")
    ap.add_argument("--size", help="(edit) เช่น 1024x1024, 1024x1536")
    ap.add_argument("--transparent", action="store_true", help="(edit) ให้พื้นหลังใส")
    ap.add_argument("--done", help="ไฟล์จดรายการ ID ที่เจนแล้ว (ข้ามใบเหล่านี้ และเพิ่ม ID ใหม่ต่อท้าย)")
    ap.add_argument("--budget", type=float, help="หยุดเมื่อใช้เงินถึงจำนวนนี้ (ดอลลาร์ ประมาณการ)")
    ap.add_argument("--force", action="store_true"); ap.add_argument("--batch"); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.cmd == "edit" and (not a.image or not a.prompt):
        fail('ใช้แบบนี้: python queue_openai.py edit ภาพ.png "สั่งแก้อะไร"')
    {"run": run_direct, "edit": run_edit, "batch-submit": batch_submit,
     "batch-status": batch_status, "batch-fetch": batch_fetch}[a.cmd](a)


if __name__ == "__main__":
    main()
