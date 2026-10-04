#!/usr/bin/env python3
"""Build a YouTube output page from an existing Gentle alignment (no models needed)."""

import argparse
import json
from pathlib import Path
import re


def build_viewer(alignment, video_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("Use the 11-character YouTube video ID, not the full URL.")
    if not isinstance(alignment, dict) or not isinstance(alignment.get("transcript"), str):
        raise ValueError("The alignment must contain a transcript string.")
    if not isinstance(alignment.get("words"), list):
        raise ValueError("The alignment must contain a words array.")

    template_path = Path(__file__).resolve().parent.parent / "www" / "view_alignment.html"
    template = template_path.read_text(encoding="utf-8")
    # Prevent transcript text such as </script> from terminating the inline script.
    data = json.dumps(alignment, ensure_ascii=True).replace("<", "\\u003c")
    template = template.replace("var SHOW_DOWNLOADS = true;", "var SHOW_DOWNLOADS = false;")
    template = template.replace(
        'var YOUTUBE_VIDEO_ID = "";', 'var YOUTUBE_VIDEO_ID = %s;' % json.dumps(video_id)
    )
    return template.replace("var INLINE_JSON;", "var INLINE_JSON = %s;" % data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("alignment", type=Path, help="existing Gentle align.json")
    parser.add_argument("video_id", help="11-character YouTube video ID")
    parser.add_argument("output", type=Path, help="HTML file to create")
    args = parser.parse_args()
    try:
        alignment = json.loads(args.alignment.read_text(encoding="utf-8"))
        html = build_viewer(alignment, args.video_id)
        # Keep the alignment and existing output files safe from accidental overwrite.
        with args.output.open("x", encoding="utf-8") as output:
            output.write(html)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print("Created %s. Serve its folder over HTTP/HTTPS to use YouTube playback." % args.output)


if __name__ == "__main__":
    main()
