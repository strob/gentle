# YouTube output viewer

This is a copyable Gentle output page for an existing YouTube video and an
already completed alignment. It uses YouTube's official embedded player instead
of an HTML5 audio element. Clicking an aligned word seeks and resumes playback;
word and available phoneme highlights follow the player's current time.

## Use your alignment

1. Copy `index.html`, `viewer.mjs` and `align.json` into one public folder.
2. Replace `align.json` with your Gentle JSON output, including `transcript` and
   `words`. In `index.html`, replace `M7lc1UVf-VE` with your 11-character video ID.
   Remove the paragraph labelling the supplied synthetic demonstration data.
3. If your transcript is in a separate UTF-8 file, set `transcriptUrl` in the
   page's configuration to that file's relative URL. It must be the exact text
   used for the alignment: offsets count Unicode characters, including spaces.
   An embedded `transcript` in the JSON is sufficient otherwise.
4. Serve the folder over HTTP(S). For example, with Python already installed,
   run `python -m http.server 8000 --bind 127.0.0.1` **inside this folder**, then
   open `http://127.0.0.1:8000/`. No Gentle engine is needed to view the output.
5. Start the video with its own Play control, then click words or use Tab and
   Enter/Space to seek. The Pause button also pauses the video.

The JSON times are seconds from the start of the YouTube video. Align the same
untrimmed audio, or correct the timestamps for any trimming before using them.
Publishing this folder makes its transcript and alignment publicly readable.
The viewer fetches these files and contacts YouTube for playback; it does not
upload them or download, transcribe or align the video.

## Timing and failure behavior

- Intervals include their start and exclude their end. Zero seconds works;
  silence/gaps and playback beyond the last word clear the highlight. A pause
  keeps the highlight at the actual paused time. Overlaps select the last
  matching word in transcript order.
- The clock is sampled from `getCurrentTime()` every 100 ms. It does not advance
  from wall-clock time while the video buffers. YouTube may initially seek to a
  nearby keyframe; the highlight follows the position actually reported by the
  player, not the requested position.
- Missing or invalid timings leave readable, non-clickable text. Invalid or
  overlapping character ranges and words absent from the transcript are counted
  as ignored records. They do not insert or discard transcript text. Text is
  rendered literally, including `<`, `&` and emoji.
- Word controls stay disabled until the player is ready. Load failures,
  unavailable/private videos, disallowed embedding, missing referrer and browser
  playback blocking have visible messages. There are no automatic retries.
  Allow YouTube scripts/media and the HTTP Referer header. Do not open this page
  through `file://`. If script playback is blocked, use the native player Play
  control. Whether playback counts as a YouTube view is determined by YouTube;
  transcript clicks do not guarantee a counted view.

The original `www/view_alignment.html` audio viewer and Gentle's input/alignment
workflow are unchanged. This example implements the output-page portion of
[issue #280](https://github.com/strob/gentle/issues/280), not YouTube URL input or
video downloading. The included four timed words are **synthetic controls**, not
a transcription of the official API sample video.

## Checks

With Node.js already installed, run from the repository root:

```sh
node --test examples/youtube-output/viewer.test.mjs
```

These tests use a synthetic DOM and YouTube API fixtures for timing boundaries,
clicks, lifecycle, text handling and errors. They do not prove remote playback.
For a browser check, open the served example, wait for Ready, click `First` and
pause: video time should be about 0:05 and `First` highlighted. Repeat with `Last`
(0:15) and `Zero` (0:00). Let `Zero` play past 0:03 to check that the gap has no
highlight. `<safe>` must display as literal text; `untimed` has no word button.

API details and error meanings:
[YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference).
