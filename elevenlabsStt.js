import WebSocket from "ws";

function buildElevenLabsSttUrl() {
  const modelId = process.env.ELEVENLABS_STT_MODEL || "scribe_v2_realtime";
  const languageCode = process.env.ELEVENLABS_STT_LANGUAGE_CODE?.trim();
  const audioFormat = process.env.ELEVENLABS_STT_AUDIO_FORMAT || "pcm_16000";
  const commitStrategy =
    process.env.ELEVENLABS_STT_COMMIT_STRATEGY || "vad";
  const vadSilenceThreshold =
    process.env.ELEVENLABS_STT_VAD_SILENCE_THRESHOLD_SECS || "1.0";
  const params = new URLSearchParams({
    model_id: modelId,
    audio_format: audioFormat,
    commit_strategy: commitStrategy,
    vad_silence_threshold_secs: String(vadSilenceThreshold),
  });
  if (languageCode) {
    params.set("language_code", languageCode);
  }
  return `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;
}

export function createElevenLabsSttStream(onTranscript, onInterimSpeech) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ELEVENLABS_API_KEY in environment");
  }

  const url = buildElevenLabsSttUrl();
  console.log("ElevenLabs STT listen:", url);

  const stt = new WebSocket(url, {
    headers: {
      "xi-api-key": apiKey,
    },
  });

  let isAlive = true;

  stt.on("open", () => {
    console.log("🧠 ElevenLabs STT connected");
  });

  stt.on("unexpected-response", (req, res) => {
    console.error("❌ ElevenLabs STT rejected:", res.statusCode);
  });

  stt.on("message", (msg) => {
    if (!isAlive) return;

    try {
      const data = JSON.parse(msg.toString());
      const type = data?.type || data?.message_type;
      const transcript = String(data?.text || "").trim();

      if (type === "session_started") {
        console.log("✅ ElevenLabs STT session started");
        return;
      }
      if (type && type.endsWith("error")) {
        console.error(`❌ ElevenLabs STT event ${type}:`, data?.error || data);
        return;
      }

      if (!transcript) return;

      if (type === "partial_transcript") {
        if (onInterimSpeech && transcript.length >= 2) onInterimSpeech(transcript);
        return;
      }

      if (
        type === "committed_transcript" ||
        type === "committed_transcript_with_timestamps"
      ) {
        console.log("Final Transcript:", transcript);
        onTranscript(transcript, true);
      }
    } catch (err) {
      console.error("ElevenLabs STT parse error:", err.message);
    }
  });

  stt.on("error", (err) => {
    console.error("ElevenLabs STT error:", err.message);
  });

  stt.on("close", (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer)
      ? reasonBuffer.toString("utf8")
      : String(reasonBuffer || "");
    console.log(`ElevenLabs STT closed (code=${code}, reason=${reason || "n/a"})`);
    isAlive = false;
  });

  stt.sendAudio = (audioBuffer) => {
    if (!isAlive || stt.readyState !== WebSocket.OPEN) return;
    const buf = Buffer.isBuffer(audioBuffer)
      ? audioBuffer
      : Buffer.from(audioBuffer);
    stt.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: buf.toString("base64"),
        sample_rate: 16000,
        commit: false,
      }),
    );
  };

  stt.safeClose = () => {
    try {
      if (!isAlive) return;
      isAlive = false;
      const state = stt.readyState;
      if (state === WebSocket.OPEN) {
        stt.close();
      } else if (state === WebSocket.CONNECTING) {
        stt.once("open", () => stt.close());
      }
    } catch (err) {
      console.error("ElevenLabs STT safe close error:", err.message);
    }
  };

  return stt;
}
