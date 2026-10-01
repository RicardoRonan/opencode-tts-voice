// voice.js — reads opencode assistant responses aloud with a natural speaking voice.
// - Text is normalized for speech (camelCase split, acronym expansion, symbol phrasing)
//   before synthesis so it sounds spoken, not read off code.
// - TTS via Microsoft Edge neural voices (edge-tts), falls back to Windows SAPI offline.
// - Playback runs in a detached Windows MediaPlayer process controlled via a control file,
//   so /voice can pause, resume, seek, and stop from inside opencode.
// State persists in voice-state.json next to this plugin.
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import os from "os";
import { tool } from "@opencode-ai/plugin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, "voice-state.json");

const DEFAULT_STATE = {
  enabled: false,
  voice: "en-US-AvaNeural",
  rate: "+0%",
  maxChars: 3000
};

const ACRONYM_SPEECH = {
  JSON: "jay son",
  API: "A P I",
  CSS: "C S S",
  HTML: "H T M L",
  HTTP: "H T T P",
  HTTPS: "H T T P S",
  SQL: "S Q L",
  URL: "U R L",
  URI: "U R I",
  NPM: "en pee em",
  YAML: "Y A M L",
  XML: "X M L",
  PDF: "P D F",
  CSV: "C S V",
  IDE: "I D E",
  SDK: "S D K",
  CLI: "C L I",
  JS: "jay ess",
  TS: "tee ess"
};

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_FILE, "utf-8")) };
    }
  } catch (err) {
    console.error("voice: failed to load state:", err.message);
  }
  return { ...DEFAULT_STATE };
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("voice: failed to save state:", err.message);
  }
}

// Turn response text into natural spoken language before synthesis.
function normalizeForSpeech(text) {
  let t = String(text)
    .replace(/```[\s\S]*?```/g, " Code block. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  t = t
    .replace(/\be\.g\.\s*/gi, "for example ")
    .replace(/\bi\.e\.\s*/gi, "that is ")
    .replace(/\betc\.?\s*/gi, "and so on ")
    .replace(/->/g, " to ")
    .replace(/=>/g, " to ")
    .replace(/→/g, " to ")
    .replace(/&/g, " and ")
    .replace(/%/g, " percent ")
    .replace(/=/g, " equals ")
    .replace(/\//g, " slash ")
    .replace(/_/g, " ");

  t = t.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  t = t.replace(/-([a-z])/g, " $1");

  for (const [k, v] of Object.entries(ACRONYM_SPEECH)) {
    t = t.replace(new RegExp(`\\b${k}\\b`, "g"), v);
  }

  t = t.replace(/\s*([.!?])\s*/g, (m, p) => p + " ");
  t = t.replace(/\s+/g, " ").trim();
  if (!/[.!?]$/.test(t)) t += ".";
  return t;
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function speakSAPI($, text) {
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$s.Rate = 1",
    `$s.Speak(${JSON.stringify(text)})`,
    "$s.Dispose()"
  ].join("; ");
  await $`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(script)}`.quiet();
}

// Polls a JSON control file { command, value, seq } every 150ms and applies it to
// the playing media. Exits when playback finishes or a stop command is received.
// Placeholders @MP3@ and @CONTROL@ are replaced with the real paths before launch,
// so no command-line arguments are needed (avoids Windows argument quoting issues).
const PLAYER_SCRIPT = `
param()
Add-Type -AssemblyName PresentationCore
$mp3 = '@MP3@'
$control = '@CONTROL@'
$p = New-Object System.Windows.Media.MediaPlayer
try {
  $p.Open([Uri]::new("file:///" + $mp3.Replace('\', '/')))
} catch {
  Remove-Item $control -ErrorAction SilentlyContinue
  Remove-Item $mp3 -ErrorAction SilentlyContinue
  exit 1
}
$p.Play()
$lastSeq = 0
$startedAt = [DateTime]::UtcNow
$sawDuration = $false
while ($true) {
  Start-Sleep -Milliseconds 150
  if (Test-Path $control) {
    try {
      $j = Get-Content $control -Raw | ConvertFrom-Json
      if ($j.seq -gt $lastSeq) {
        $lastSeq = $j.seq
        switch ($j.command) {
          "pause" { $p.Pause() }
          "resume" { $p.Play() }
          "stop" {
            $p.Stop()
            $p.Close()
            Remove-Item $control -ErrorAction SilentlyContinue
            Remove-Item $mp3 -ErrorAction SilentlyContinue
            exit 0
          }
          "seek" {
            if ($p.NaturalDuration.HasTimeSpan) {
              $d = $p.NaturalDuration.TimeSpan
              if ($d.TotalMilliseconds -gt 0) {
                $pos = $p.Position.Add([TimeSpan]::FromSeconds([double]$j.value))
                if ($pos -lt [TimeSpan]::Zero) { $pos = [TimeSpan]::Zero }
                if ($pos -gt $d) { $pos = $d }
                $p.Position = $pos
              }
            }
          }
        }
      }
    } catch {}
  }
  if ($p.NaturalDuration.HasTimeSpan -and $p.NaturalDuration.TimeSpan.TotalMilliseconds -gt 0) {
    $sawDuration = $true
    $d = $p.NaturalDuration.TimeSpan
    if ($p.Position.TotalMilliseconds -ge ($d.TotalMilliseconds - 200)) { break }
  }
  if (([DateTime]::UtcNow - $startedAt).TotalSeconds -gt 300 -and -not $sawDuration) {
    break
  }
}
$p.Close()
Remove-Item $control -ErrorAction SilentlyContinue
Remove-Item $mp3 -ErrorAction SilentlyContinue
exit 0
`;

let activeControl = null;
let seq = 0;

function writeControl(control, command, value = 0) {
  try {
    if (!control) return;
    seq++;
    writeFileSync(control, JSON.stringify({ command, value, seq }));
  } catch (err) {
    console.error("voice: failed to write control:", err.message);
  }
}

function stopCurrent() {
  writeControl(activeControl, "stop");
  activeControl = null;
}

function launchPlayer($, mp3, control) {
  const ps1 = join(os.tmpdir(), `opencode-voice-player-${Date.now()}.ps1`);
  writeFileSync(
    ps1,
    PLAYER_SCRIPT.replace("@MP3@", mp3).replace("@CONTROL@", control)
  );
  const cmd = [
    "Start-Process",
    "-FilePath", "powershell.exe",
    "-ArgumentList", "'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','" + ps1 + "'",
    "-WindowStyle", "Hidden"
  ].join(" ");
  return $`powershell.exe -NoProfile -NonInteractive -Command ${cmd}`.quiet();
}

async function speak($, text, state) {
  const cleaned = normalizeForSpeech(text);
  if (!cleaned) return;
  stopCurrent();
  const mp3 = join(os.tmpdir(), `opencode-voice-${Date.now()}.mp3`);
  const control = join(os.tmpdir(), `opencode-voice-${Date.now()}.ctrl.json`);
  activeControl = control;
  writeControl(control, "none", 0);
  try {
    await $`python -m edge_tts --voice ${state.voice} --rate ${state.rate} --text ${cleaned.slice(0, state.maxChars)} --write-media ${mp3}`.quiet();
    if (!existsSync(mp3)) throw new Error("edge-tts produced no audio");
    await launchPlayer($, mp3, control);
  } catch (err) {
    console.error("voice: edge-tts failed, falling back to SAPI:", err.message);
    activeControl = null;
    try {
      unlinkSync(mp3);
    } catch (err2) {
    }
    await speakSAPI($, cleaned);
  }
}

async function getLastAssistantText(client, sessionID, back = 1) {
  const res = await client.session.messages({ path: { id: sessionID } });
  const messages = res?.data ?? res;
  if (!Array.isArray(messages)) return null;
  let found = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.info?.role === "assistant" && !m.info.summary) {
      const parts = (m.parts ?? []).filter((p) => p.type === "text" && !p.synthetic);
      const text = parts.map((p) => p.text).join("\n").trim();
      if (!text) continue;
      found++;
      if (found === back) return text;
    }
  }
  return null;
}

const VoicePlugin = async ({ client, $ }) => {
  let currentSessionID = null;

  const voiceTool = tool({
    description:
      "Control opencode voice reading (text-to-speech). Actions: on, off, toggle, status, voice <name> (e.g. en-US-AvaNeural, en-US-GuyNeural), rate <x%>, last [n] (read the most recent assistant response aloud, or the n-th response back), pause, resume, seek <seconds> (jump forward/back, e.g. 30 or -15), stop (stop playback), test <text>.",
    args: {
      action: tool.schema
        .enum(["on", "off", "toggle", "status", "voice", "rate", "last", "pause", "resume", "seek", "stop", "test"])
        .describe("Action to perform"),
      value: tool.schema.string().optional().describe("Voice name, rate string, seek seconds, or text to speak for test")
    },
    execute: async ({ action, value }, { sessionID }) => {
      const state = loadState();
      switch (action) {
        case "on":
          state.enabled = true;
          saveState(state);
          return { output: `Voice reading is now ON. Voice: ${state.voice}. Rate: ${state.rate}.` };
        case "off":
          state.enabled = false;
          stopCurrent();
          saveState(state);
          return { output: "Voice reading is now OFF." };
        case "toggle":
          state.enabled = !state.enabled;
          if (!state.enabled) stopCurrent();
          saveState(state);
          return { output: `Voice reading is now ${state.enabled ? "ON" : "OFF"}.` };
        case "voice":
          if (value) {
            state.voice = value;
            saveState(state);
            return { output: `Voice set to ${state.voice}.` };
          }
          return { output: `Current voice: ${state.voice}.` };
        case "rate":
          if (value) {
            state.rate = value;
            saveState(state);
            return { output: `Rate set to ${state.rate}.` };
          }
          return { output: `Current rate: ${state.rate}.` };
        case "last": {
          const back = Math.max(1, parseInt(value ?? "1", 10) || 1);
          const text = await getLastAssistantText(client, sessionID, back);
          if (!text) return { output: "No assistant response found to read." };
          await speak($, text, state);
          return { output: `Reading response ${back === 1 ? "" : `(${back} back) `}aloud with ${state.voice}.` };
        }
        case "pause":
          if (activeControl) {
            writeControl(activeControl, "pause");
            return { output: "Playback paused." };
          }
          return { output: "Nothing is currently playing." };
        case "resume":
          if (activeControl) {
            writeControl(activeControl, "resume");
            return { output: "Playback resumed." };
          }
          return { output: "Nothing is currently playing." };
        case "seek": {
          const seconds = parseFloat(value ?? "0");
          if (!Number.isFinite(seconds)) return { output: "Provide seconds, e.g. /voice seek 30 or /voice seek -15." };
          if (activeControl) {
            writeControl(activeControl, "seek", seconds);
            return { output: `Seeked ${seconds >= 0 ? "+" : ""}${seconds}s.` };
          }
          return { output: "Nothing is currently playing." };
        }
        case "stop":
          if (activeControl) {
            stopCurrent();
            return { output: "Playback stopped." };
          }
          return { output: "Nothing is currently playing." };
        case "test": {
          const phrase = value ?? "Voice test successful.";
          await speak($, phrase, state);
          return { output: `Speaking: "${phrase}" with ${state.voice}.` };
        }
        case "status":
          return {
            output: `Voice reading: ${state.enabled ? "ON" : "OFF"}. Voice: ${state.voice}. Rate: ${state.rate}.`
          };
      }
      return { output: "Unknown action." };
    }
  });

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        currentSessionID = event.properties?.info?.id ?? event.properties?.sessionID ?? null;
      }
      if (event.type === "session.idle" && currentSessionID === event.properties?.sessionID) {
        const state = loadState();
        if (!state.enabled) return;
        const text = await getLastAssistantText(client, event.properties.sessionID);
        if (text) await speak($, text, state);
      }
    },
    tool: { voice: voiceTool }
  };
};

export { VoicePlugin };
export default VoicePlugin;