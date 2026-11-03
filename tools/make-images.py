#!/usr/bin/env python3
"""Генерирует оптимизированные WebP из оригиналов images/*.png в images/web/.

Запуск: python3 tools/make-images.py [папка-с-оригиналами] [папка-для-webp]
Оригиналы: hero, <id десерта>, fillings, chef-hands, gift-box — .png или .jpg.
hero: 768, 1152, 1536 px по ширине (оригинал 1536 — не растягиваем);
hero-sq: квадратный кроп hero для телефонов (640, 1024); остальные: 480, 900 px. Качество 80.
Оригиналы не трогаются. Повторный запуск перезаписывает WebP.
"""
import sys
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "images"
OUT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else SRC / "web"
OUT.mkdir(parents=True, exist_ok=True)

SIZES = {"hero": [768, 1152, 1536]}
HERO_SQUARE_BOX = (300, 0, 1324, 1024)  # демо: кроп вокруг торта и макарон (для фото 1536x1024)
HERO_SQUARE = [640, 1024]
DEFAULT = [480, 900]

def show(p):
    try:
        return p.relative_to(ROOT)
    except ValueError:
        return p

originals = sorted([*SRC.glob("*.png"), *SRC.glob("*.jpg"), *SRC.glob("*.jpeg")])
for png in originals:
    name = png.stem
    im = ImageOps.exif_transpose(Image.open(png)).convert("RGB")
    for w in SIZES.get(name, DEFAULT):
        target_w = min(w, im.width)
        h = round(im.height * target_w / im.width)
        resized = im.resize((target_w, h), Image.LANCZOS) if target_w != im.width else im
        dst = OUT / f"{name}-{w}.webp"
        resized.save(dst, "WEBP", quality=80, method=6)
        print(f"{show(dst)}  {target_w}x{h}  {dst.stat().st_size // 1024} KB")

hero_src = next((p for p in originals if p.stem == "hero"), None)
if hero_src is None:
    sys.exit("Нет главного фото hero.png / hero.jpg")
hero = ImageOps.exif_transpose(Image.open(hero_src)).convert("RGB")
if hero.size == (1536, 1024):
    hero = hero.crop(HERO_SQUARE_BOX)
else:  # квадрат по центру; при необходимости поправьте кадр вручную
    side = min(hero.size)
    left, top = (hero.width - side) // 2, (hero.height - side) // 2
    hero = hero.crop((left, top, left + side, top + side))
for w in HERO_SQUARE:
    dst = OUT / f"hero-sq-{w}.webp"
    (hero.resize((w, w), Image.LANCZOS) if w != hero.width else hero).save(dst, "WEBP", quality=80, method=6)
    print(f"{show(dst)}  {w}x{w}  {dst.stat().st_size // 1024} KB")
