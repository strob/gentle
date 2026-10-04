import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("youtube_viewer", ROOT / "examples" / "youtube_viewer.py")
viewer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(viewer)


class YouTubeViewerTest(unittest.TestCase):
    def test_build_inlines_alignment_and_video_id(self):
        alignment = json.loads((ROOT / "examples" / "youtube_alignment.json").read_text())
        html = viewer.build_viewer(alignment, "M7lc1UVf-VE")
        self.assertIn('var YOUTUBE_VIDEO_ID = "M7lc1UVf-VE";', html)
        self.assertIn("var SHOW_DOWNLOADS = false;", html)
        self.assertNotIn("var INLINE_JSON;", html)
        self.assertIn('"start": 0', html)
        self.assertIn('"case": "not-found-in-audio"', html)

    def test_script_terminator_in_transcript_is_escaped(self):
        alignment = {"transcript": "</script><script>alert(1)</script>", "words": []}
        html = viewer.build_viewer(alignment, "M7lc1UVf-VE")
        self.assertEqual(html.count("</script>"), 1)
        self.assertIn("\\u003c/script>", html)

    def test_invalid_inputs_are_rejected(self):
        with self.assertRaises(ValueError):
            viewer.build_viewer({"transcript": "", "words": []}, "https://youtu.be/M7lc1UVf-VE")
        with self.assertRaises(ValueError):
            viewer.build_viewer({"words": []}, "M7lc1UVf-VE")
        with self.assertRaises(ValueError):
            viewer.build_viewer({"transcript": "", "words": {}}, "M7lc1UVf-VE")
