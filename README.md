# OpenDX7

A web-based 6-operator FM synthesizer built with the Web Audio API.

Created by Keith Adler. Inspired by the Yamaha DX7 synthesizer.

## Features

- Clean-room 6-operator FM (phase modulation) synthesis engine
- 32 operator routing algorithms
- 4-stage rate/level envelope generators per operator
- Keyboard level scaling, velocity sensitivity, operator detune
- LFO with 6 waveforms, delay, and sync
- Pitch envelope generator
- Feedback per algorithm
- 16-voice polyphony
- SysEx bank file loading (.SYX)
- MIDI input with sustain pedal support
- Computer keyboard playback
- 32 built-in factory patches
- Real-time parameter editing with visual feedback

## Running

Serve the project directory over HTTP:

```
python3 -m http.server 8080
```

Open http://localhost:8080 in your browser.

## Controls

- Click the on-screen keyboard or use your computer keyboard (A-L row, Z-M row)
- Connect a MIDI controller for velocity-sensitive playback
- Load .SYX bank files to import patches
- Edit any parameter in real time via the UI

## License

MIT — see [LICENSE](LICENSE).
