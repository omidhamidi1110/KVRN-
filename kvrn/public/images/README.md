# KVRN Image Assets

Add your product and campaign images to the subdirectories below.
The site renders placeholder UI until images are provided.

All images should be in **WebP format** for optimal performance.
Provide JPEG fallbacks for maximum compatibility.

---

## /campaign/

| Filename                      | Dimensions    | Purpose                          |
|-------------------------------|---------------|----------------------------------|
| hero-drop001.webp             | 1920×1080px   | Homepage hero (desktop)          |
| hero-drop001-mobile.webp      | 1080×1920px   | Homepage hero (mobile, 9:16)     |
| fabric-macro.webp             | 1400×1750px   | Material story section (4:5)     |
| editorial-drop001.webp        | 1920×823px    | Editorial strip (21:9)           |

---

## /products/

Naming convention: `{product}-{color}-{shot}.webp`

### Hoodie (kh-001)

| Filename                          | Size        | Shot type              |
|-----------------------------------|-------------|------------------------|
| hoodie-stone-front.webp           | 1500×2000px | Front, full length     |
| hoodie-stone-back.webp            | 1500×2000px | Back, full length      |
| hoodie-stone-hood.webp            | 1500×2000px | Hood macro             |
| hoodie-stone-fabric.webp          | 1200×1200px | Fabric close-up        |
| hoodie-stone-zip-closed.webp      | 1200×1200px | Pocket exterior        |
| hoodie-stone-zip-open.webp        | 1200×1200px | Interior zipper open   |
| hoodie-stone-lifestyle.webp       | 1500×2000px | Lifestyle, worn        |
| hoodie-slate-front.webp           | 1500×2000px | Front, full length     |
| hoodie-slate-back.webp            | 1500×2000px | Back                   |
| hoodie-slate-hood.webp            | 1500×2000px | Hood macro             |
| hoodie-slate-fabric.webp          | 1200×1200px | Fabric                 |
| hoodie-slate-lifestyle.webp       | 1500×2000px | Lifestyle              |
| hoodie-offwhite-front.webp        | 1500×2000px | Front                  |
| hoodie-offwhite-back.webp         | 1500×2000px | Back                   |
| hoodie-offwhite-lifestyle.webp    | 1500×2000px | Lifestyle              |
| hoodie-washedblack-front.webp     | 1500×2000px | Front                  |
| hoodie-washedblack-back.webp      | 1500×2000px | Back                   |
| hoodie-washedblack-lifestyle.webp | 1500×2000px | Lifestyle              |

### Sweatpants (ks-001)

| Filename                            | Size        | Shot type          |
|-------------------------------------|-------------|--------------------|
| sweatpants-stone-front.webp         | 1500×2000px | Front              |
| sweatpants-stone-back.webp          | 1500×2000px | Back               |
| sweatpants-stone-fabric.webp        | 1200×1200px | Fabric             |
| sweatpants-stone-lifestyle.webp     | 1500×2000px | Lifestyle          |
| sweatpants-slate-front.webp         | 1500×2000px | Front              |
| sweatpants-slate-back.webp          | 1500×2000px | Back               |
| sweatpants-slate-lifestyle.webp     | 1500×2000px | Lifestyle          |
| sweatpants-offwhite-front.webp      | 1500×2000px | Front              |
| sweatpants-offwhite-back.webp       | 1500×2000px | Back               |
| sweatpants-washedblack-front.webp   | 1500×2000px | Front              |
| sweatpants-washedblack-back.webp    | 1500×2000px | Back               |

---

## /construction/

| Filename                    | Size        | Purpose                       |
|-----------------------------|-------------|-------------------------------|
| hood-structure.webp         | 1200×1200px | 3-panel hood construction     |
| interior-zippers.webp       | 1200×1200px | Hidden zipper detail          |
| fabric-weight.webp          | 1200×1200px | Fabric weight / GSM close-up  |
| panel-seam.webp             | 1200×1200px | Hood panel seam detail        |
| stitch-detail.webp          | 1200×1200px | Stitch quality close-up       |
| kvrn-patch.webp             | 1200×1200px | Rubber patch on hood          |

---

## Image quality guidelines (from V3 Blueprint)

- **Product shots:** Export at 85% WebP quality. Target file size: 80–140KB per image.
- **Macro/detail shots:** Export at 90% quality. Target: 60–100KB.
- **Hero/campaign:** Export at 85% quality. Target: 150–250KB.
- **Never upscale.** Shoot at or above the target resolution.
- **Color grading:** Apply your Kodak Portra 400 LUT before exporting.
  All images must share the same colour temperature.
- **Add `next/image` `priority` prop** to the first product image on each page.

---

## Optimisation tools

```bash
# Convert JPEG to WebP (install cwebp first)
cwebp -q 85 hoodie-stone-front.jpg -o hoodie-stone-front.webp

# Batch convert
for f in *.jpg; do cwebp -q 85 "$f" -o "${f%.jpg}.webp"; done

# Check file sizes
du -sh *.webp | sort -h
```
