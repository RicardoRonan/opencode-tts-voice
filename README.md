# opencode-tts-voice

A text-to-speech plugin for [opencode](https://opencode.ai) that reads assistant responses aloud with a natural Microsoft neural voice -> and lets you pause, seek, resume, and stop playback from inside the TUI.

Built and maintained by **TheDevRicardo** -> [thedevricardo.co.za](https://thedevricardo.co.za)

## Features

- **Natural spoken output** -> responses are normalized for speech before synthesis: camelCase identifiers are split, tech acronyms are expanded (`JSON → "jay son"`, `API → "A P I"`), symbols are phrased (`-> → "to"`, `% → "percent"`), and markdown is stripped, so it sounds read aloud rather than read off code.
- **On-demand reading** -> read the most recent response (or the n-th response back) without enabling auto-read.
- **Optional auto-read** -> toggle to speak every response when the session goes idle.
- **Full playback control** -> pause, resume, seek, and stop from inside opencode via slash commands.
- **Voice + rate selection** -> switch between 100+ Microsoft Edge neural voices and adjust speaking rate.
- **Offline fallback** -> if `edge-tts` is unavailable, falls back to Windows built-in SAPI speech.
- **Zero cloud API keys** -> uses Microsoft's free Edge TTS neural voices.

## Requirements

- **OS** -> Windows 10 or 11 (the playback controller uses the built-in Windows MediaPlayer runtime, `PresentationCore`)
- **[opencode](https://opencode.ai)** (latest, so plugin tool registration is supported)
- **Python 3** (3.9+)
- **edge-tts** -> `pip install edge-tts`
  - Requires an internet connection to reach Microsoft's neural voice service (needed only at synthesis time)
  - If the `edge-tts` CLI is not on your `PATH`, the plugin calls it as `python -m edge_tts`, so a working `python` on `PATH` is enough
- **No API keys** -> no cloud account, token, or subscription required
- Optional: `ffmpeg`/`ffplay` for other audio tooling (not required for playback)

## Install

1. Copy `plugin/voice.js` into your opencode plugins directory (global plugins auto-load from this folder at startup):

   ```
   ~/.config/opencode/plugins/voice.js
   ```

2. Add the `/voice` command to `~/.config/opencode/opencode.jsonc` (see `opencode.jsonc.example`):

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "command": {
       "voice": {
         "description": "Control voice reading (TTS). Usage: /voice on|off|toggle|status|voice <name>|rate <x%>|last [n]|pause|resume|seek <s>|stop|test",
         "agent": "build",
         "template": "Call the voice tool to handle this request. The user typed: $ARGUMENTS. You MUST invoke the voice tool with the appropriate action now - do not describe it, do not summarize what it would do. Then report the tool's result in one short line."
       }
     }
   }
   ```

3. Restart opencode.

## Usage

| Command | Description |
| --- | --- |
| `/voice last` | Read the most recent assistant response aloud |
| `/voice last 2` | Read the response two turns back |
| `/voice on` | Auto-read every response when the session goes idle |
| `/voice off` | Disable auto-read (default) |
| `/voice pause` | Pause current playback |
| `/voice resume` | Resume playback |
| `/voice seek 30` | Jump forward 30 seconds (`/voice seek -15` jumps back) |
| `/voice stop` | Stop playback immediately |
| `/voice voice en-US-GuyNeural` | Change voice |
| `/voice rate +10%` | Speed up (`-10%` slows down) |
| `/voice test` | Hear the current voice |
| `/voice status` | Show current state |

## Voices

Pick from Microsoft's Edge neural voices. Popular English ones:

- `en-US-AvaNeural` (default, female)
- `en-US-EmmaNeural` (female)
- `en-US-JennyNeural` (female)
- `en-US-AriaNeural` (female)
- `en-US-GuyNeural` (male)
- `en-US-BrianNeural` (male)
- `en-US-AndrewNeural` (male)
- `en-GB-SoniaNeural`, `en-GB-RyanNeural`, `en-AU-NatashaNeural`, and many more

List all voices: `edge-tts --list-voices`

## How it works

1. On `session.idle` (or `/voice last`), the plugin fetches the latest assistant message.
2. The text is **normalized for speech** (`normalizeForSpeech`) so it sounds natural when spoken.
3. `edge-tts` synthesizes the audio locally to a temp MP3.
4. A detached Windows MediaPlayer process plays the MP3 while polling a JSON control file every 150 ms.
5. Slash commands (`pause`, `resume`, `seek`, `stop`) write to that control file, giving you live playback control from the prompt.

State (enabled, voice, rate) persists in `voice-state.json` next to the plugin.

## Notes

- The `/voice` command routes to the plugin's registered `voice` tool, so it works in any agent, not just `build`.
- Only works in an interactive session while opencode is running (the detached player is cleaned up when playback finishes or is stopped).
- Long responses are capped at `maxChars` (default 3000) to keep playback snappy.

## License

MIT