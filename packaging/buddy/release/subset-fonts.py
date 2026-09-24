# /// script
# requires-python = ">=3.12"
# dependencies = ["fonttools[woff]==4.66.0", "brotli==1.2.0", "zopfli==0.4.3"]
# ///

import argparse
from io import BytesIO
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont


def main():
    parser = argparse.ArgumentParser(description="Generate Buddy UI font subsets from the bundled originals and locale files.")
    parser.add_argument("--check", action="store_true", help="Verify the committed subsets without writing files.")
    args = parser.parse_args()
    buddy = Path(__file__).resolve().parents[3] / "apps" / "buddy"
    codepoints = set(range(0x20, 0x7F))
    for locale in sorted((buddy / "src" / "i18n" / "locales").rglob("*.ts")):
        codepoints.update(map(ord, locale.read_text(encoding="utf-8")))

    for weight in ("regular", "medium"):
        name = f"lxgw-wenkai-{weight}.woff2"
        source = buddy / "resources" / "fonts" / name
        destination = buddy / "src" / "assets" / "fonts" / name
        with TTFont(source, recalcTimestamp=False) as font:
            options = subset.Options()
            options.layout_features = ["*"]
            subsetter = subset.Subsetter(options)
            subsetter.populate(unicodes=sorted(codepoints.intersection(font.getBestCmap())))
            subsetter.subset(font)
            output = BytesIO()
            font.save(output)
        data = output.getvalue()
        if args.check:
            if destination.read_bytes() != data:
                raise SystemExit(f"Font subset is out of date: {destination}")
        else:
            destination.write_bytes(data)
        print(f"{name}: {source.stat().st_size} -> {len(data)} bytes")


if __name__ == "__main__":
    main()
