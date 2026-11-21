#!/usr/bin/env bash
# Download optional third-party test photos; see THIRD_PARTY_NOTICES.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMG="$ROOT/test/site/img"
OTHER="$ROOT/test/site/other"
DARKNET="https://raw.githubusercontent.com/pjreddie/darknet/f6afaabcdf85f77e7aff2ec55c020c0e297c77f9/data"
YOLOV5="https://raw.githubusercontent.com/ultralytics/yolov5/1e7cf74cb64d719b34f7315aa13eab9e32cde672/data/images"

command -v magick >/dev/null || { echo 'ImageMagick (magick) is required for test fixtures.' >&2; exit 1; }
mkdir -p "$IMG" "$OTHER"
for name in person horses eagle giraffe; do
  curl -fsSL --retry 3 "$DARKNET/$name.jpg" -o "$IMG/$name.jpg"
done
curl -fsSL --retry 3 "$DARKNET/dog.jpg" -o "$IMG/dog-bike-truck.jpg"
for name in bus zidane; do
  curl -fsSL --retry 3 "$YOLOV5/$name.jpg" -o "$IMG/$name.jpg"
done

magick "$IMG/bus.jpg" -strip -resize 400x "$IMG/bus-400.jpg"
magick "$IMG/bus.jpg" -strip -resize 800x "$IMG/bus-800.jpg"
magick "$IMG/dog-bike-truck.jpg" -strip -resize 600x "$IMG/dog-600.jpg"
magick "$IMG/dog-bike-truck.jpg" -strip -resize 64x64! "$IMG/icon-dog-64.png"
magick "$IMG/zidane.jpg" -strip -resize 640x "$IMG/tile-zidane.jpg"
cp "$IMG/horses.jpg" "$IMG/giraffe.jpg" "$IMG/texture-swirl.jpg" "$OTHER/"
echo 'Optional test photographs are ready (not covered by the project MIT license).'
