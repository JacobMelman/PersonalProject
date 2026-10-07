# Demo film credits

* **Recording:** `scripts/film.mjs` drives the real ReproDesk extension in headed Chromium (virtual display, genuine mouse and keyboard input) through the Northwind Gear demo shop and records the screen with ffmpeg. Nothing in the film is mocked.
* **Voice-over:** synthesized offline with [Piper](https://github.com/OHF-Voice/piper1-gpl) (`piper-tts`, GPL-3.0, used only as a tool to produce the audio; it is not part of the extension) and the `en_US` "joe" medium voice, published as CC0-1.0 in the npm package `vowel-lab-voices-float` 0.1.0. Narration text and timing: `NARRATION` in `scripts/film.mjs`; synthesis and mixing: `scripts/narrate.py`.
* **Captions:** generated from the same narration, one caption per spoken phrase, timed to the synthesized audio (`reprodesk-demo.en.srt`).
* **Font:** Inter (SIL Open Font License 1.1).

To use another voice: `FILM_VOICE_MODEL=/path/en_US-voice.onnx npm run demo:film` (the matching `.onnx.json` must sit next to it).
