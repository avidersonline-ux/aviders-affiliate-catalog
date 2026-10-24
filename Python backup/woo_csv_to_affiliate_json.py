#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
WooCommerce CSV  ->  Static JSON for GitHub Pages
- Keeps ONLY Type = external (affiliate) rows
- Maps key columns to a compact JSON format for your Flutter app
- Preserves your full category paths like:
  "Our Trusted Partners > Exclusive Offers > Accessories"
- Produces:
    /data/products-0001.json, products-0002.json, ...
    /data/manifest.json  (with index for fast filter loading)
- No extra packages required (pure Python stdlib)
"""

import csv
import json
import os
import re
import sys
import time
import tkinter as tk
from tkinter import filedialog, messagebox
from pathlib import Path
from datetime import datetime, timezone
from typing import List, Dict, Any, Tuple, Set

# ------------------------- CONFIG -------------------------

PAGE_SIZE = 1000                 # items per JSON page
OUT_DIR = Path("data")           # output folder
CURRENCY = "INR"
DEFAULT_TYPE = "external"        # we keep only this type

# Heuristic audience extraction from categories
AUDIENCE_KEYWORDS = {
    "men": "Men",
    "women": "Women",
    "kids": "Kids",
    "girls": "Girls",
    "boys": "Boys",
}

# ------------------------- HELPERS -------------------------

def safe_get(row: Dict[str, str], *keys: str, default: str = "") -> str:
    """Try many header spellings, return first non-empty."""
    for k in keys:
        if k in row and str(row[k]).strip():
            return str(row[k]).strip()
    return default

def split_multi_images(s: str) -> List[str]:
    """Woo images separated by commas; trim spaces."""
    if not s:
        return []
    # handle comma-separated with potential spaces
    parts = [x.strip() for x in s.split(",") if x.strip()]
    return parts

def split_categories(cat_str: str) -> List[str]:
    """
    Input example:
      "Our Trusted Partners > Exclusive Offers > Accessories, Our Trusted Partners > E-commerce brands"
    Returns list of full paths as entered.
    """
    if not cat_str:
        return []
    parts = [x.strip() for x in cat_str.split(",") if x.strip()]
    return parts

def now_unix() -> int:
    return int(time.time())

def derive_audience_from_paths(paths: List[str]) -> List[str]:
    found: Set[str] = set()
    for p in paths:
        low = p.lower()
        for kw, label in AUDIENCE_KEYWORDS.items():
            if kw in low:
                found.add(label)
    return sorted(found)

def clean_price(val: str) -> float:
    try:
        if val is None:
            return 0.0
        v = re.sub(r"[^0-9.\-]", "", str(val))
        if v == "" or v == "." or v == "-":
            return 0.0
        return float(v)
    except Exception:
        return 0.0

def normalize_spaces(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()

def page_filename(page_num: int) -> str:
    return f"products-{page_num:04d}.json"

# ------------------------- CORE -------------------------

def map_row_to_item(row: Dict[str, str]) -> Dict[str, Any]:
    """Map Woo CSV row to compact JSON item."""
    pid = safe_get(row, "ID")
    ptype = safe_get(row, "Type", default=DEFAULT_TYPE).lower()
    sku = safe_get(row, "SKU")
    name = safe_get(row, "Name", "Product Name")

    sale_price = clean_price(safe_get(row, "Sale price"))
    reg_price = clean_price(safe_get(row, "Regular price"))
    price = sale_price if sale_price > 0 else reg_price
    mrp = reg_price if reg_price > 0 else price

    cat_raw = safe_get(row, "Categories")
    category_paths = split_categories(cat_raw)

    # topCategory = first segment before '>' of first path (if any)
    top_category = ""
    if category_paths:
        first = category_paths[0]
        top_category = first.split(">")[0].strip() if ">" in first else first.strip()

    # Collect unique short category names (all segments after '>')
    categories_set: Set[str] = set()
    for full in category_paths:
        segs = [x.strip() for x in full.split(">")]
        if len(segs) > 1:
            categories_set.update(segs[1:])
        else:
            categories_set.update(segs)

    images = split_multi_images(safe_get(row, "Images", "Image"))
    image = images[0] if images else ""
    thumb = images[1] if len(images) > 1 else (image or "")

    external_url = safe_get(row, "External URL", "URL", "Product URL", "Link", default="")
    brand = safe_get(row, "Brands", "Brand", default="")
    short_desc = safe_get(row, "Short description")

    item = {
        "id": str(pid),
        "type": ptype or DEFAULT_TYPE,
        "sku": sku,
        "title": name,
        "price": price,
        "mrp": mrp,
        "currency": CURRENCY,
        "brand": brand,
        "image": image,
        "thumb": thumb or image,
        "externalUrl": external_url,
        "topCategory": top_category,
        "categoryPaths": category_paths,
        "categories": sorted(categories_set),
        "shortDesc": short_desc,
        "audience": derive_audience_from_paths(category_paths),
        "updatedAt": now_unix(),
    }
    return item

def build_indexes(items: List[Dict[str, Any]], page_map: Dict[int, List[str]]) -> Dict[str, Any]:
    """
    Build manifest indexes:
      - top:  { "Our Trusted Partners": [1,2,...] }
      - sub:  { "Our Trusted Partners > Exclusive Offers": [1,...] }
      - leaf: { "Our Trusted Partners > Exclusive Offers > Accessories": [1,...] }
      - facets: optional (audience)
    page_map: page -> list of product IDs on that page (not used here directly, but kept for future)
    """
    top_index: Dict[str, Set[int]] = {}
    sub_index: Dict[str, Set[int]] = {}
    leaf_index: Dict[str, Set[int]] = {}
    audience_index: Dict[str, Set[int]] = {}

    # Determine page number per item via id lookup table
    id_to_page: Dict[str, int] = {}
    for pnum, ids in page_map.items():
        for pid in ids:
            id_to_page[pid] = pnum

    for it in items:
        pid = it["id"]
        pnum = id_to_page.get(pid, 1)
        top = it.get("topCategory", "")
        paths = it.get("categoryPaths", []) or []
        audiences = it.get("audience", []) or []

        if top:
            top_index.setdefault(top, set()).add(pnum)

        for full in paths:
            segs = [x.strip() for x in full.split(">") if x.strip()]
            if len(segs) >= 2:
                sub = " > ".join(segs[:2])
                sub_index.setdefault(sub, set()).add(pnum)
            if len(segs) >= 3:
                leaf_index.setdefault(full, set()).add(pnum)
            elif len(segs) == 1:
                # single level path; treat as leaf
                leaf_index.setdefault(segs[0], set()).add(pnum)

        for a in audiences:
            audience_index.setdefault(a, set()).add(pnum)

    # Convert sets to sorted lists
    def conv(d: Dict[str, Set[int]]) -> Dict[str, List[int]]:
        return {k: sorted(list(v)) for k, v in d.items()}

    return {
        "top": conv(top_index),
        "sub": conv(sub_index),
        "leaf": conv(leaf_index),
        "facets": {
            "audience": conv(audience_index)
        }
    }

def process_csv(csv_path: Path) -> Tuple[List[Dict[str, Any]], List[List[Dict[str, Any]]], Dict[int, List[str]]]:
    """Read CSV, filter to external type, map to items, then chunk."""
    items: List[Dict[str, Any]] = []

    # Read with universal newline + utf-8-sig to strip BOM if present
    with csv_path.open("r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        # normalize headers to exact as-is (Woo exports standard names)
        for row in reader:
            ptype = safe_get(row, "Type").lower()
            if ptype != DEFAULT_TYPE:
                continue  # skip non-external
            item = map_row_to_item(row)
            # must have at least title and externalUrl/image
            if not item["title"]:
                continue
            if not item["externalUrl"] and not item["image"]:
                # if no link and no image, skip
                continue
            items.append(item)

    # sort stable by id (string)
    items.sort(key=lambda x: x["id"])

    # chunk into pages
    pages: List[List[Dict[str, Any]]] = []
    page_map: Dict[int, List[str]] = {}  # page -> ids
    for i in range(0, len(items), PAGE_SIZE):
        chunk = items[i:i+PAGE_SIZE]
        pages.append(chunk)
        pnum = len(pages)
        page_map[pnum] = [it["id"] for it in chunk]

    return items, pages, page_map

def write_output(pages: List[List[Dict[str, Any]]], items: List[Dict[str, Any]], page_map: Dict[int, List[str]]):
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Write page files
    for i, chunk in enumerate(pages, start=1):
        out_file = OUT_DIR / page_filename(i)
        with out_file.open("w", encoding="utf-8") as f:
            json.dump(chunk, f, ensure_ascii=False, separators=(",", ":"), indent=2)
        print(f"wrote {out_file}")

    # Write manifest with indexes
    indexes = build_indexes(items, page_map)
    manifest = {
        "version": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total": len(items),
        "pageSize": PAGE_SIZE,
        "pages": len(pages),
        "index": indexes
    }
    with (OUT_DIR / "manifest.json").open("w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"), indent=2)
    print(f"wrote {OUT_DIR / 'manifest.json'}")

# ------------------------- UI (double-click) -------------------------

def main():
    root = tk.Tk()
    root.withdraw()
    messagebox.showinfo(
        "Aviders CSV → JSON",
        "Select your WooCommerce CSV export (external/affiliate products)."
    )
    csv_file = filedialog.askopenfilename(
        title="Select WooCommerce CSV",
        filetypes=[("CSV Files", "*.csv"), ("All Files", "*.*")]
    )
    if not csv_file:
        messagebox.showwarning("Aviders CSV → JSON", "No file selected. Exiting.")
        return

    csv_path = Path(csv_file)
    try:
        items, pages, page_map = process_csv(csv_path)
        if not items:
            messagebox.showwarning("Aviders CSV → JSON", "No external/affiliate products found in CSV.")
            return
        write_output(pages, items, page_map)
        abs_out = (OUT_DIR).resolve()
        messagebox.showinfo(
            "Done",
            f"Created {len(pages)} page(s) in:\n{abs_out}\n\nUpload the entire 'data' folder to your GitHub repo."
        )
    except Exception as e:
        messagebox.showerror("Error", f"Failed: {e}")
        raise

if __name__ == "__main__":
    main()
