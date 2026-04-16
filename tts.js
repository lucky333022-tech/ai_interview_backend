import axios from "axios";

const DEFAULT_VOICE = "X5RWySWhCXiGdP9YIKck";

/** Devanagari block — if present, hint Hindi so ElevenLabs normalizes/pronounces correctly */
function containsDevanagari(text) {
  return /[\u0900-\u097F]/.test(text);
}

export async function streamTTS(text) {
  const voiceId =
    process.env.ELEVENLABS_VOICE_ID ||
    process.env.VOICE_ID_OF_TTS ||
    DEFAULT_VOICE;

  // Multilingual v2 handles Hindi + English/Hinglish better than turbo for typical voices.
  const modelId =
    process.env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2";

  const body = {
    text,
    model_id: modelId,
    voice_settings: {
      stability: 0.45,
      similarity_boost: 0.75,
    },
  };

  if (
    containsDevanagari(text) &&
    process.env.ELEVENLABS_TTS_NO_LANGUAGE_CODE !== "1"
  ) {
    body.language_code = "hi";
  }

  try {
    const response = await axios({
      method: "post",
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      data: body,
      responseType: "arraybuffer",
    });

    return response.data;
  } catch (err) {
    const data = err.response?.data;
    let detail = data;
    if (Buffer.isBuffer(data)) {
      try {
        detail = JSON.parse(data.toString("utf8"));
      } catch {
        detail = data.toString("utf8");
      }
    }
    console.error("TTS Error:", err.response?.status, detail);
    throw err;
  }
}
