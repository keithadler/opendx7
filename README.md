# OpenDX7

**Version 1.1**

A browser-based Yamaha DX7 FM synthesizer. No plugins, no installs — just open and play.

### ▶ [Play now](https://keithadler.github.io/opendx7/)

Built with the Web Audio API. Verified against the [Dexed/msfa](https://github.com/asb2m10/dexed) open-source DX7 engine for accuracy.

Created by Keith Adler.

## Features

**Synthesis engine**
- 6-operator FM (phase modulation) matching the DX7's YM21280 OPS chip
- All 32 algorithms with bus-based routing ported from Dexed's algorithm table
- 4-stage rate/level envelopes with Dexed-accurate qrate formula and scaleoutlevel curves
- Per-sample recursive feedback matching Dexed's compute_fb (levels 1–7)
- Output level, velocity, and keyboard scaling combined in the log domain
- 16-voice polyphony with voice stealing

**Patch compatibility**
- Loads real DX7 SysEx bank files (.SYX, 32-voice bulk dump)
- Correct packed voice parsing (128 bytes per voice)
- 32 custom built-in patches (original designs, not copies of DX7 ROM)

**Performance controls**
- On-screen pitch bend wheel (spring-return) and mod wheel
- MIDI input with velocity, sustain pedal, pitch bend, mod wheel, aftertouch
- Computer keyboard mapping (A–L and Z–M rows)

**UI**
- SVG arc knobs with drag, scroll, and double-click reset
- High-DPI envelope and algorithm visualizations
- Real-time waveform, peak/RMS meters, voice activity
- Chord and key detection with rolling history
- Effects presets (reverb, delay, shimmer, etc.)

## Quick start

```
python3 -m http.server 8080
```

Open http://localhost:8080. Select a sound and play.

## Loading DX7 patches

Click **LOAD SYX** and select any standard DX7 32-voice SysEx bank file. Thousands of .SYX banks are available online. Standard factory cartridge dumps load out of the box.

## Keyboard mapping

| Keys | Notes |
|------|-------|
| A S D F G H J K L | C4 – C5 (white keys) |
| W E T Y U O P | C#4 – B4 (black keys) |
| Z X C V B N M | C3 – B3 |

## Architecture

```
index.html          — UI shell
js/dx7-processor.js — AudioWorklet: FM engine, envelopes, algorithms
js/dx7-patch.js     — Patch structures, SysEx parser, built-in patches
js/main.js          — UI wiring, audio context, MIDI, chord detection
js/knob.js          — SVG knob component
js/env-display.js   — Envelope canvas renderer
js/algo-display.js  — Algorithm diagram renderer
css/style.css       — Styles
test/               — Engine and patch test suites (833 tests)
```

## Tests

```
node test/operator-vs-dexed.js  # 9 Dexed reference comparison tests
node test/dx7-engine-test.js    # 132 engine tests
node test/algo-test.js          # 224 algorithm routing tests
node test/patch-test.js         # 211 patch tests
node test/sysex-test.js         # 229 SysEx roundtrip tests
node test/e2e-test.js           # 28 end-to-end tests
```

## References

- [Dexed](https://github.com/asb2m10/dexed) — open-source DX7 plugin (Apache 2.0)
- [Ken Shirriff's DX7 reverse engineering](https://www.righto.com/2021/11/reverse-engineering-yamaha-dx7.html)
- [ajxs DX7 technical analysis](https://ajxs.me/blog/Yamaha_DX7_Technical_Analysis.html)

## Changelog

#### Version 1.1
- Fixed 13 built-in patches whose operators sat at the wrong indices for their algorithm after the v1.0 operator-order migration — modulation chains were dead or carriers played at modulator levels (FM Bass, Synth Bass, FM Brass, Soft Brass, String Pad, Warm Strings, Flute Tone, Reed Pipe, Synth Lead, Bright Lead, Harpsichord, Choir Pad, Deep Sub Bass, Pluck Bass, Warm Pad, Sync Lead).
- Fixed a stray full-level INIT sine that leaked into every built-in patch not explicitly configuring OP1.
- Operator tabs now edit the operator they're labeled with (tab 1 edited OP6 due to the msfa/Dexed ops[] ordering).
- SysEx export no longer corrupts zero-valued parameters (detune 0, coarse 0.5 ratio, transpose 0, pitch EG zeros); pitch bend range 0 is honored.
- LFO delay direction corrected: higher values now wait longer before the LFO fades in, matching the DX7.
- Algorithms 4 and 6 now use the DX7's loop feedback (OP4→OP6, OP5→OP6) instead of OP6 self-feedback.
- Algorithm diagrams redrawn from the engine's routing table — 24 of 32 were wrong (carriers, chains, or feedback op).
- Fixed a race where two quick notes during audio startup created a second AudioContext.
- Double-click knob reset now returns center-based knobs (detune, transpose, pitch EG levels, PB range) to their defaults instead of zero.
- Mod wheel and aftertouch now add vibrato (LFO pitch depth) instead of statically detuning the note.
- Removed the donation link from the README.

#### Version 1.0
- Fixed SysEx operator ordering — loaded .SYX banks were mirror-imaged relative to their algorithm roles (carriers became modulators), producing near-noise. Import/export now use msfa/Dexed operator order to match the engine.
- Fixed modulation bus summing — modulators that add to an internal bus (algorithm opcodes 0x05/0x25/0xc5) were overwriting the bus and leaking into the audio output as carriers. Now matches Dexed's `render()` add-vs-overwrite semantics.
- Corrected per-algorithm carrier counts and the default INIT voice for the fixed operator order.
- These fixes resolve the v0.2 known issue: loaded patches now match a real DX7 / Dexed, including high-feedback and complex modulation patches.
- Removed the copyrighted Yamaha ROM cartridge data; supply your own .SYX banks via **LOAD SYX**.

#### Version 0.2
- Fixed LFO running 64x too slow (advanced per-sample instead of per-block)
- Fixed output scaling to match Dexed's >>4 normalization — eliminates clipping on multi-carrier patches
- Fixed effects chain: reverb/delay isolated through master bus with brick-wall limiter
- Delay feedback clamped to prevent runaway
- Default patch set to Elec Piano 1 on startup
- Next chord suggestions stay visible until new chord played

#### Version 0.1
- Initial release

## License

MIT — see [LICENSE](LICENSE).
