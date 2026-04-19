// ===================== server.js (CALL CENTER INTERVIEW) =====================
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { createElevenLabsSttStream } from "./elevenlabsStt.js";
import { streamLLM } from "./openai.js";
import { streamTTS } from "./tts.js";
import { evaluateInterview } from "./evaluateInterview.js";
import {
  DEFAULT_INTERVIEW_CATEGORY,
  INTERVIEW_CATEGORIES,
  buildPriyaSystemPrompt,
  getCategoryConfig,
} from "./interviewCategories.js";
import {
  createInterviewSession,
  updateInterviewSession,
  upsertInterviewResult,
} from "./sessionRepository.js";
import dotenv from "dotenv";
dotenv.config();

const LLM_PROVIDER = "openai";
const STT_PROVIDER = "elevenlabs";

console.log("🧠 LLM provider: openai");
console.log("🎙️ STT provider: elevenlabs");

const PORT = Number(process.env.PORT || 3000);

// Render health checks expect an HTTP responder. We still serve WebSockets
// on the same port via the HTTP server upgrade mechanism.
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({ server: httpServer });

const INTERVIEW_MS = 10 * 60 * 1000;
const WARNING_BEFORE_END_MS = 60 * 1000;

/** ElevenLabs closes the realtime STT socket with these reasons when retrying will not help. */
function isElevenLabsSttFatalCloseReason(reason) {
  const r = String(reason || "").toLowerCase();
  return (
    r.includes("insufficient_funds") ||
    r.includes("quota_exceeded") ||
    r.includes("invalid_api_key")
  );
}

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

let connectionId = 0;

function validateStartPayload(obj) {
  const category = String(obj?.category || "").trim().toLowerCase();
  const userName = String(obj?.user_name || "").trim();
  const phoneNumber = String(obj?.phone_number || "").trim();
  const jobDescription = String(obj?.job_description ?? "").trim();

  if (!category || !(category in INTERVIEW_CATEGORIES)) {
    return {
      ok: false,
      error: `Invalid category. Allowed: ${Object.keys(INTERVIEW_CATEGORIES).join(", ")}`,
    };
  }
  if (!userName || userName.length < 2) {
    return { ok: false, error: "user_name is required (min 2 chars)." };
  }
  if (!/^\d{10}$/.test(phoneNumber)) {
    return { ok: false, error: "phone_number must be a 10-digit number." };
  }

  return {
    ok: true,
    value: {
      category,
      user_name: userName,
      phone_number: phoneNumber,
      job_description: jobDescription,
    },
  };
}

/** First segment flushes sooner (comma / shorter cap) so TTS starts earlier. */
function shouldFlushTtsSegment(buffer, isFirstSegment) {
  const t = buffer.trimEnd();
  const endsSentence =
    t.endsWith(".") ||
    t.endsWith("?") ||
    t.endsWith("!") ||
    t.endsWith("।") ||
    t.endsWith("॥");
  const endsClause = /[,，;]\s*$/.test(t);
  if (endsSentence) return true;
  if (isFirstSegment && endsClause) return true;
  if (isFirstSegment && buffer.length >= 36) return true;
  if (!isFirstSegment && buffer.length >= 76) return true;
  return false;
}

function tryParseControlPayload(data, isBinary) {
  if (isBinary) {
    if (!Buffer.isBuffer(data) || data.length > 4096) return null;
    if (data[0] !== 0x7b) return null;
    try {
      const obj = JSON.parse(data.toString("utf8"));
      return obj?.type ? obj : null;
    } catch {
      return null;
    }
  }
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  if (!text.trimStart().startsWith("{")) return null;
  try {
    const obj = JSON.parse(text);
    return obj?.type ? obj : null;
  } catch {
    return null;
  }
}

wss.on("connection", (ws) => {
  const id = ++connectionId;
  console.log(`🟢 Client ${id} connected (ws open)`);

  /** @type {'INIT'|'SESSION_CREATED'|'UPLINK_READY'|'LIVE'|'ENDING'|'ENDED'} */
  let transportState = "INIT";
  function setTransportState(next, note = "") {
    if (transportState === next) return;
    console.log(
      `[${id}] transportState: ${transportState} -> ${next}${note ? ` (${note})` : ""}`,
    );
    transportState = next;
  }

  let isSpeaking = false;
  let sttStream = null;
  let sttOpen = false;
  let sessionId = null;
  let interviewCategory = DEFAULT_INTERVIEW_CATEGORY;
  let sessionUserName = "";
  let sessionPhoneNumber = "";
  /** Optional job description for Priya system prompt (primary focus when set). */
  let sessionJobDescription = "";

  let lastTranscript = "";
  let lastCallTime = 0;
  /** Min gap between delivered user lines. */
  const COOLDOWN = 800;

  /** Ignore STT noise; finals shorter than this are not sent to the LLM. */
  const MIN_USER_TRANSCRIPT_CHARS = 5;

  /** Flush user text only after this much continuous silence since last speech activity. */
  const USER_UTTERANCE_GAP_MS = Number(
    process.env.USER_UTTERANCE_GAP_MS ||
      process.env.USER_UTTERANCE_DEBOUNCE_MS ||
      4000,
  );

  /** Accumulate consecutive STT finals into one user message. */
  let userPendingUtterance = "";
  let userUtteranceDebounceTimer = null;
  let lastUserSpeechAt = 0;
  let lastInterimTranscript = "";

  function clearUserUtteranceDebounce() {
    if (userUtteranceDebounceTimer) {
      clearTimeout(userUtteranceDebounceTimer);
      userUtteranceDebounceTimer = null;
    }
  }

  function scheduleUserUtteranceFlush() {
    if (!userPendingUtterance) return;
    clearUserUtteranceDebounce();
    userUtteranceDebounceTimer = setTimeout(() => {
      userUtteranceDebounceTimer = null;
      const elapsed = Date.now() - lastUserSpeechAt;
      if (elapsed < USER_UTTERANCE_GAP_MS) {
        scheduleUserUtteranceFlush();
        return;
      }
      const merged = userPendingUtterance.trim();
      userPendingUtterance = "";
      lastUserSpeechAt = 0;
      if (merged) {
        void deliverMergedUserUtterance(merged).catch((err) =>
          console.error("deliver merged utterance:", err),
        );
      }
    }, USER_UTTERANCE_GAP_MS);
  }

  /** Rough end time for assistant audio still playing on the client (barge-in window). */
  let assistantPlaybackUntil = 0;
  let lastBargeInAt = 0;

  function extendAssistantPlaybackDeadline(byteLength) {
    if (!byteLength) return;
    const ms = Math.min(180_000, Math.round((byteLength / 16000) * 1000 * 1.25));
    assistantPlaybackUntil = Math.max(assistantPlaybackUntil, Date.now() + ms);
  }

  function sendAssistantAudio(audioBuffer) {
    if (!allowAudioOut || !isSpeaking || ws.readyState !== WebSocket.OPEN) return;
    const buf = Buffer.isBuffer(audioBuffer)
      ? audioBuffer
      : Buffer.from(audioBuffer);
    extendAssistantPlaybackDeadline(buf.byteLength);
    ws.send(buf);
  }

  function handleUserBargeIn() {
    const now = Date.now();
    if (now - lastBargeInAt < 250) return;
    lastBargeInAt = now;
    assistantPlaybackUntil = 0;
    isSpeaking = false;
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "stop_assistant_audio" }));
      } catch {
        /* ignore */
      }
    }
  }

  let isLLMRunning = false;

  /** @type {'idle' | 'live' | 'closing' | 'done'} */
  let phase = "idle";
  let interviewStartedAt = 0;
  let interviewTimer = null;
  let warningTimer = null;
  /** @type {{ role: string, text: string, at: number }[]} */
  let transcriptHistory = [];
  let interviewFinalized = false;
  /** When false, do not send TTS audio to the client (user ended interview or stopped mic). */
  let allowAudioOut = true;
  let finalizationInFlight = false;
  let sttConnectPromise = null;
  let reconnectSttTimer = null;
  let earlyPcmDroppedCount = 0;
  let firstPcmReceivedLogged = false;
  let firstPcmForwardedLogged = false;
  let interviewStartNotified = false;
  /** @type {'hindi_or_hinglish' | 'english'} */
  let preferredLanguageMode = "hindi_or_hinglish";

  function normalizeForIntent(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isGreetingOnlyUtterance(text) {
    const normalized = normalizeForIntent(text);
    if (!normalized) return false;
    const greetingWords = new Set([
      "hi",
      "hello",
      "hey",
      "namaste",
      "namaskar",
      "salaam",
      "salam",
      "ram ram",
      "good morning",
      "good evening",
      "good afternoon",
      "kaise ho",
      "kese ho",
      "kaisi ho",
      "kaisa hai",
      "kaisi hain",
      "aur batao",
      "aur sunao",
    ]);
    if (greetingWords.has(normalized)) return true;
    return /^((hi|hello|hey|namaste|namaskar|salaam|salam)\s*)+$/.test(
      normalized,
    );
  }

  function isExplicitEnglishSwitchRequest(text) {
    const normalized = normalizeForIntent(text);
    if (!normalized) return false;
    const englishPatterns = [
      /\b(speak|talk|continue|reply|answer|ask)\b.*\benglish\b/,
      /\benglish\b.*\b(speak|talk|continue|reply|answer|ask)\b/,
      /\b(can|could|please)\b.*\benglish\b/,
      /\benglish\s+mein\b/,
      /\benglish\s+me\b/,
      /\bangrezi\s+mein\b/,
      /\bangrezi\s+me\b/,
      /\benglish\s+me\s+bolo\b/,
      /\benglish\s+mein\s+bolo\b/,
      /\bin english please\b/,
      /\bcan you speak english\b/,
    ];
    return englishPatterns.some((rx) => rx.test(normalized));
  }

  function isExplicitHindiSwitchRequest(text) {
    const normalized = normalizeForIntent(text);
    if (!normalized) return false;
    const hindiPatterns = [
      /\b(hindi|hinglish)\b.*\b(speak|talk|continue|reply|answer|ask|bolo)\b/,
      /\b(speak|talk|continue|reply|answer|ask|bolo)\b.*\b(hindi|hinglish)\b/,
      /\bhindi\s+mein\b/,
      /\bhindi\s+me\b/,
      /\bhinglish\s+mein\b/,
      /\bhinglish\s+me\b/,
      /\bhindi\s+me\s+bolo\b/,
      /\bhindi\s+mein\s+bolo\b/,
      /\bhindi me baat\b/,
      /\bhindi mein baat\b/,
    ];
    return hindiPatterns.some((rx) => rx.test(normalized));
  }

  function updateLanguagePreferenceFromUser(userText) {
    if (isGreetingOnlyUtterance(userText)) return;
    if (isExplicitEnglishSwitchRequest(userText)) {
      preferredLanguageMode = "english";
      console.log(`[${id}] language_mode -> english`);
      return;
    }
    if (isExplicitHindiSwitchRequest(userText)) {
      preferredLanguageMode = "hindi_or_hinglish";
      console.log(`[${id}] language_mode -> hindi_or_hinglish`);
    }
  }

  function getRecentTranscriptContext(maxLines = 6) {
    const recent = transcriptHistory.slice(-maxLines);
    if (!recent.length) return "No prior transcript yet.";
    return recent
      .map((entry) => {
        const speaker = entry.role === "assistant" ? "Interviewer" : "Candidate";
        return `${speaker}: ${entry.text}`;
      })
      .join("\n");
  }

  function getPriyaLanguageLine() {
    if (preferredLanguageMode === "english") {
      return "English. The candidate requested English; conduct your replies in English unless they ask for Hindi/Hinglish.";
    }
    return "Hindi and Hinglish. Default to natural Hindi; use Hinglish when appropriate. Use English only if the candidate explicitly asks.";
  }

  function getInterviewSystemPrompt() {
    const cfg = getCategoryConfig(interviewCategory);
    const sessionPolicy =
      preferredLanguageMode === "english"
        ? "Session language: English unless the candidate asks to switch back to Hindi/Hinglish."
        : "Session language: Hindi/Hinglish by default. Do not drift to English unless the candidate explicitly asks.";
    return `${buildPriyaSystemPrompt({
      name: sessionUserName || "Candidate",
      userId: sessionId ? String(sessionId) : "pending",
      knowledgeContext: cfg.knowledgeContext,
      language: getPriyaLanguageLine(),
      categoryLabel: cfg.label,
      jobDescription: sessionJobDescription,
    })}

Session-level policy (in addition to rules above):
- ${sessionPolicy}
- Greetings: do not open replies with Namaste/Hello/name unless their last message was greeting-only; see "Greeting and name usage" in the system prompt.
- If the candidate asks about language preference, acknowledge in one short line and continue in that language.`;
  }

  function getTurnPrompt(userText) {
    const cfg = getCategoryConfig(interviewCategory);
    const languageModeInstruction =
      preferredLanguageMode === "english"
        ? "Candidate explicitly requested English. Continue in English unless they ask to switch back."
        : "Default: Hindi/Hinglish. Continue in Hindi/Hinglish unless they explicitly request English.";
    const greetingOnly = isGreetingOnlyUtterance(userText);
    const greetingHandlingInstruction = greetingOnly
      ? `Their message is greeting-only. CRITICAL: Mirror in 2–5 words only (same style as them). Do NOT say "${sessionUserName}" or "Namaste ${sessionUserName}". Do NOT re-introduce yourself as Priya. Do NOT repeat your previous question verbatim—ask a NEW follow-up on the same topic.`
      : `CRITICAL: Their message is substantive. Do NOT start with Namaste, Hello, Good morning, or with the candidate's name. Start directly with feedback on their answer and/or your next question. Continue the ongoing topic; do not restart the interview.`;
    return `${cfg.turnPromptBuilder(userText)}

Session constraints:
- Role: ${cfg.label}.
- ${languageModeInstruction}
- ${greetingHandlingInstruction}

Recent transcript (most recent context at bottom):
${getRecentTranscriptContext()}`;
  }

  function getFirstQuestionPrompt() {
    const cfg = getCategoryConfig(interviewCategory);
    const lang =
      preferredLanguageMode === "english"
        ? "Use English for this reply (candidate has not spoken yet; opening was in Hindi)."
        : "Use Hindi or Hinglish for this reply to match the default interview language.";
    return `Internal instruction: The fixed Hindi welcome was already spoken. The candidate has not answered yet.

Ask exactly ONE clear first interview question for the ${cfg.label} role. ${lang}
Do not repeat the welcome, your name, or the module line. Do not start with Namaste or the candidate's name—the opening already greeted them. Keep it short.`;
  }

  function buildFixedOpeningHindiText() {
    const cfg = getCategoryConfig(interviewCategory);
    const mod = String(cfg.moduleLabel || "training module").trim();
    return `Namaste ${sessionUserName}! Main Priya hoon, aapki AI interviewer. Aaj hum ${mod} pe kuch sawaal karenge. Toh chalo shuru karte hain.`;
  }

  /**
   * Non-LLM assistant line: fixed script + TTS + transcript (used for Hindi opening).
   */
  async function playAssistantUtterance(scriptText) {
    if (phase === "done") return;
    const trimmed = String(scriptText || "").trim();
    if (!trimmed) return;
    isSpeaking = true;
    try {
      const audioBuffer = await streamTTS(trimmed);
      if (allowAudioOut && ws.readyState === WebSocket.OPEN) {
        sendAssistantAudio(audioBuffer);
      }
      const t = Date.now();
      transcriptHistory.push({ role: "assistant", text: trimmed, at: t });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "transcript_final",
            speaker: "assistant",
            text: trimmed,
            ts: t,
          }),
        );
      }
    } catch (err) {
      console.error("TTS (fixed script) error:", err.message);
    } finally {
      isSpeaking = false;
    }
  }

  async function deliverFixedOpeningAndFirstQuestion() {
    await playAssistantUtterance(buildFixedOpeningHindiText());
    await runAssistantTurn(getFirstQuestionPrompt());
  }

  function sendAudioUplinkReady() {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "audio_uplink_ready",
        session_id: sessionId,
        sample_rate: 16000,
        format: "pcm_s16le",
        channels: 1,
      }),
    );
    console.log(`[${id}] audio_uplink_ready sent (session=${sessionId})`);
  }

  function sendAudioUplinkPause(reason = "stt_not_ready") {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "audio_uplink_pause",
        session_id: sessionId,
        reason,
      }),
    );
    console.log(`[${id}] audio_uplink_pause sent (reason=${reason})`);
  }

  function sendAudioUplinkResume(reason = "stt_reconnected") {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "audio_uplink_resume",
        session_id: sessionId,
        reason,
      }),
    );
    console.log(`[${id}] audio_uplink_resume sent (reason=${reason})`);
  }

  async function ensureSttClient() {
    if (
      sttStream &&
      sttOpen &&
      sttStream.readyState === WebSocket.OPEN &&
      !sttConnectPromise
    ) {
      return sttStream;
    }
    if (sttConnectPromise) return sttConnectPromise;

    sttConnectPromise = new Promise((resolve, reject) => {
      try {
        console.log(`[${id}] STT client create start`);
        let sttReadyResolved = false;

        if (sttStream) {
          try {
            sttStream.safeClose?.();
          } catch {
            /* ignore */
          }
        }

        sttOpen = false;
        sttStream = createElevenLabsSttStream(onTranscript, (interimText) => {
          const t = (interimText || "").trim();
          if (t.length < 2) return;
          lastUserSpeechAt = Date.now();
          if (phase === "live" && ws.readyState === WebSocket.OPEN && t !== lastInterimTranscript) {
            lastInterimTranscript = t;
            ws.send(
              JSON.stringify({
                type: "transcript_partial",
                speaker: "candidate",
                text: t,
                ts: Date.now(),
              }),
            );
          }
          if (userPendingUtterance) scheduleUserUtteranceFlush();
          const playbackActive =
            phase === "live" && Date.now() < assistantPlaybackUntil;
          if (!playbackActive) return;
          console.log(`🎤 [${id}] Barge-in (user speaking over assistant)`);
          handleUserBargeIn();
        });

        const streamRef = sttStream;

        const openTimeout = setTimeout(() => {
          sttConnectPromise = null;
          reject(new Error("STT open timeout"));
        }, 10000);

        sttStream.on("open", () => {
          clearTimeout(openTimeout);
          sttOpen = true;
          console.log(`[${id}] STT client created/open`);
          const sessionStartedTimeout = setTimeout(() => {
            sttConnectPromise = null;
            reject(new Error("STT session_started timeout"));
          }, 10000);

          const onSessionMessage = (msg) => {
            try {
              const data = JSON.parse(msg.toString());
              const typ = data?.type || data?.message_type;
              if (typ !== "session_started") return;
              sttReadyResolved = true;
              clearTimeout(sessionStartedTimeout);
              streamRef.off("message", onSessionMessage);
              sttConnectPromise = null;
              resolve(streamRef);
            } catch {
              /* ignore parse failures while waiting for session_started */
            }
          };

          streamRef.on("message", onSessionMessage);
        });

        sttStream.on("close", (code, reasonBuf) => {
          sttOpen = false;
          sttStream = null;
          const reason = Buffer.isBuffer(reasonBuf)
            ? reasonBuf.toString("utf8")
            : String(reasonBuf || "");
          console.log(
            `❌ ${STT_PROVIDER} closed (client ${id}) code=${code} reason=${reason || "n/a"}`,
          );
          if (!sttReadyResolved && sttConnectPromise) {
            sttConnectPromise = null;
            reject(
              new Error(
                reason
                  ? `STT connection closed before ready: ${reason}`
                  : `STT connection closed before ready (code ${code})`,
              ),
            );
          }
          if (
            STT_PROVIDER === "elevenlabs" &&
            isElevenLabsSttFatalCloseReason(reason)
          ) {
            clearTimeout(reconnectSttTimer);
            reconnectSttTimer = null;
            console.error(
              `[${id}] STT will not reconnect (fatal close from ElevenLabs). Check credits/API key at https://elevenlabs.io`,
            );
            sendAudioUplinkPause("stt_fatal_close");
            clearInterviewTimers();
            phase = "idle";
            setTransportState("ENDED", "stt_fatal_close");
            if (interviewStartNotified && ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session_error",
                  code: "STT_PROVIDER_BILLING",
                  service: "stt",
                  recoverable: false,
                  error:
                    "Speech recognition stopped: ElevenLabs reported insufficient credits or a billing/API issue. Add credits or verify ELEVENLABS_API_KEY in the ElevenLabs dashboard.",
                }),
              );
            }
            return;
          }
          if (transportState === "LIVE" || transportState === "UPLINK_READY") {
            sendAudioUplinkPause("stt_closed");
            setTransportState("SESSION_CREATED", "stt_closed");
            clearTimeout(reconnectSttTimer);
            reconnectSttTimer = setTimeout(async () => {
              if (phase !== "live" || interviewFinalized) return;
              try {
                await ensureSttClient();
                if (phase !== "live" || interviewFinalized) return;
                setTransportState("UPLINK_READY", "stt_reconnected");
                sendAudioUplinkReady();
                sendAudioUplinkResume("stt_reconnected");
                setTransportState("LIVE", "uplink_resumed");
              } catch (err) {
                console.error(`[${id}] STT reconnect failed:`, err.message);
              }
            }, 1000);
          }
        });

        sttStream.on("error", (err) => {
          console.error(`${STT_PROVIDER} error:`, err.message);
        });
      } catch (err) {
        sttConnectPromise = null;
        reject(err);
      }
    });

    return sttConnectPromise;
  }

  function clearInterviewTimers() {
    if (interviewTimer) clearTimeout(interviewTimer);
    if (warningTimer) clearTimeout(warningTimer);
    interviewTimer = null;
    warningTimer = null;
  }

  function interviewDeadlinePassed() {
    if (!interviewStartedAt) return true;
    return Date.now() >= interviewStartedAt + INTERVIEW_MS;
  }

  async function finalizeInterview(reason) {
    if (interviewFinalized || finalizationInFlight) return;
    setTransportState("ENDING", `finalize_${reason}`);
    finalizationInFlight = true;
    interviewFinalized = true;
    clearInterviewTimers();
    phase = "done";
    const endedAt = Date.now();

    try {
      const evaluation = await evaluateInterview(
        transcriptHistory,
        reason,
        interviewCategory,
      );

      try {
        await updateInterviewSession(sessionId, {
          used_at: new Date(endedAt).toISOString(),
        });
        await upsertInterviewResult(sessionId, {
          category: interviewCategory,
          module: "ai-interview",
          user_name: sessionUserName,
          phone_number: sessionPhoneNumber,
          reason,
          evaluation,
          transcriptHistory,
          modelProvider: LLM_PROVIDER,
          modelName: process.env.OPENAI_MODEL || "gpt-4o-mini",
        });
      } catch (dbErr) {
        console.error(`[session ${sessionId}] DB finalize error:`, dbErr.message);
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "session_update",
            session_id: sessionId,
            status: "done",
            reason,
          }),
        );
        ws.send(
          JSON.stringify({
            type: "interview_result",
            reason,
            session_id: sessionId,
            category: interviewCategory,
            evaluation,
          })
        );
        console.log(
          `[${id}] result sent (session=${sessionId}, reason=${reason}, score=${evaluation?.score ?? "n/a"})`,
        );
      }
    } finally {
      setTransportState("ENDED", `finalized_${reason}`);
      finalizationInFlight = false;
    }
  }

  async function waitForLlmIdle() {
    while (isLLMRunning) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async function deliverMergedUserUtterance(cleanText) {
    if (phase !== "live") return;
    if (interviewDeadlinePassed()) return;

    const merged = cleanText.trim();
    if (!merged) return;

    if (merged.length < MIN_USER_TRANSCRIPT_CHARS) {
      console.log("⏳ Merged transcript too short, ignoring");
      return;
    }

    if (merged === lastTranscript) {
      console.log("⚠️ Duplicate");
      return;
    }

    await waitForLlmIdle();
    if (phase !== "live" || interviewDeadlinePassed()) return;

    const now = Date.now();
    if (now - lastCallTime < COOLDOWN) {
      console.log("⏳ Cooldown");
      return;
    }

    if (merged === lastTranscript) return;

    lastTranscript = merged;
    lastCallTime = Date.now();

    updateLanguagePreferenceFromUser(merged);
    transcriptHistory.push({ role: "user", text: merged, at: lastCallTime });
    console.log(`🗣 [${id}] User:`, merged);
    lastInterimTranscript = "";
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "transcript_final",
          speaker: "candidate",
          text: merged,
          ts: lastCallTime,
        }),
      );
    }

    const prompt = getTurnPrompt(merged);
    await runAssistantTurn(prompt);
  }

  async function onInterviewTimeout() {
    if (phase !== "live" && phase !== "closing") return;
    phase = "closing";
    console.log(`⏱ [${id}] Interview time limit reached`);
    try {
      await updateInterviewSession(sessionId, {
        used_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error("timeout session update error:", err.message);
    }
    clearUserUtteranceDebounce();
    const pendingTimeout = userPendingUtterance.trim();
    userPendingUtterance = "";
    if (pendingTimeout) await deliverMergedUserUtterance(pendingTimeout);
    await waitForLlmIdle();
    try {
      const closingText =
        "Samay samapt ho gaya. Aapka interview yahi samapt hota hai. Dhanyavaad.";
      const audioBuffer = await streamTTS(closingText);
      if (allowAudioOut && ws.readyState === WebSocket.OPEN) {
        isSpeaking = true;
        sendAssistantAudio(audioBuffer);
      }
    } catch (err) {
      console.error("Timeout closing TTS:", err.message);
    }
    await finalizeInterview("timeout");
  }

  function armInterviewTimers() {
    clearInterviewTimers();
    const endsAt = interviewStartedAt + INTERVIEW_MS;
    warningTimer = setTimeout(() => {
      if (phase === "live" && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "time_warning",
            remainingMs: WARNING_BEFORE_END_MS,
          })
        );
      }
    }, Math.max(0, INTERVIEW_MS - WARNING_BEFORE_END_MS));

    interviewTimer = setTimeout(() => {
      onInterviewTimeout();
    }, INTERVIEW_MS);
  }

  async function handleControlMessage(obj) {
    if (obj.type === "start_interview") {
      console.log(`[${id}] start_interview received`);
      const validated = validateStartPayload(obj);
      if (!validated.ok) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: "session_error", error: validated.error }),
          );
        }
        return;
      }
      const input = validated.value;

      clearInterviewTimers();
      interviewFinalized = false;
      finalizationInFlight = false;
      allowAudioOut = true;
      assistantPlaybackUntil = 0;
      transcriptHistory = [];
      lastTranscript = "";
      lastCallTime = 0;
      interviewStartNotified = false;
      preferredLanguageMode = "hindi_or_hinglish";
      userPendingUtterance = "";
      lastUserSpeechAt = 0;
      lastInterimTranscript = "";
      clearUserUtteranceDebounce();
      phase = "live";
      interviewStartedAt = Date.now();
      setTransportState("INIT", "start_interview_reset");
      interviewCategory = input.category;
      sessionUserName = input.user_name;
      sessionPhoneNumber = input.phone_number;
      sessionJobDescription = input.job_description || "";

      try {
        const session = await createInterviewSession({
          category: interviewCategory,
          user_name: sessionUserName,
          phone_number: sessionPhoneNumber,
          module: "ai-interview",
          started_at: new Date(interviewStartedAt).toISOString(),
          duration_ms: INTERVIEW_MS,
          used_at: new Date(interviewStartedAt).toISOString(),
        });
        sessionId = session?.sid || null;
        setTransportState("SESSION_CREATED", "session_created");
      } catch (err) {
        console.error("create session error:", err.message);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "session_error",
              error: err.message || "Could not create interview session",
            }),
          );
        }
        phase = "idle";
        return;
      }

      try {
        await ensureSttClient();
        setTransportState("UPLINK_READY", "stt_open");
        sendAudioUplinkReady();
        setTransportState("LIVE", "uplink_ready");
        armInterviewTimers();
        const endsAt = interviewStartedAt + INTERVIEW_MS;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "transcript_reset" }));
          ws.send(
            JSON.stringify({
              type: "session_update",
              session_id: sessionId,
              status: "session_created",
            }),
          );
          ws.send(
            JSON.stringify({
              type: "interview_started",
              endsAt,
              session_id: sessionId,
              category: interviewCategory,
              user_name: sessionUserName,
              phone_number: sessionPhoneNumber,
              stt_ready: true,
            }),
          );
          interviewStartNotified = true;
          console.log(`[${id}] interview_started sent (session=${sessionId})`);
          ws.send(
            JSON.stringify({
              type: "session_update",
              session_id: sessionId,
              status: "live",
            }),
          );
        }
        console.log(
          `▶ [${id}] Interview started, session=${sessionId}, category=${interviewCategory}, endsAt=${endsAt}`,
        );
      } catch (err) {
        console.error(`[${id}] STT create failed:`, err.message);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "session_error",
              code: "STT_INIT_FAILED",
              service: "stt",
              recoverable: false,
              error: `STT initialization failed: ${err.message}`,
            }),
          );
        }
        phase = "idle";
        setTransportState("ENDED", "stt_init_failed");
        return;
      }

      await deliverFixedOpeningAndFirstQuestion();
      return;
    }

    if (obj.type === "end_interview") {
      if (phase !== "live" && phase !== "closing") return;
      allowAudioOut = false;
      isSpeaking = false;
      assistantPlaybackUntil = 0;
      phase = "closing";
      setTransportState("ENDING", "manual_end");
      clearInterviewTimers();
      console.log(`■ [${id}] Interview ended by user`);
      try {
        await updateInterviewSession(sessionId, {
          used_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error("manual session update error:", err.message);
      }
      clearUserUtteranceDebounce();
      const pendingEnd = userPendingUtterance.trim();
      userPendingUtterance = "";
      lastUserSpeechAt = 0;
      if (pendingEnd) await deliverMergedUserUtterance(pendingEnd);
      await waitForLlmIdle();
      await finalizeInterview("manual");
      return;
    }

    if (obj.type === "end" && phase === "live") {
      allowAudioOut = false;
      isSpeaking = false;
      assistantPlaybackUntil = 0;
      console.log(`🔇 [${id}] Recorder stop — halting TTS output`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "session_update",
            session_id: sessionId,
            status: "recording_stopped",
          }),
        );
      }
      clearUserUtteranceDebounce();
      const pendingMic = userPendingUtterance.trim();
      userPendingUtterance = "";
      lastUserSpeechAt = 0;
      if (pendingMic) void deliverMergedUserUtterance(pendingMic);
      return;
    }
  }

  /**
   * Streams LLM + TTS; appends full assistant text to transcriptHistory.
   */
  async function runAssistantTurn(userPrompt) {
    if (phase === "done") return;

    isLLMRunning = true;
    isSpeaking = true;
    let fullAssistant = "";

    try {
      const llmStream = await streamLLM(userPrompt, {
        systemPrompt: getInterviewSystemPrompt(),
      });

      let buffer = "";
      let isFirstSegment = true;

      // ElevenLabs returns 409 conflict (already_running) if two TTS requests for the
      // same voice overlap. Must await each streamTTS before starting the next.

      async function flushTtsSegment(text) {
        const trimmed = text.trim();
        if (!trimmed) return;
        const audioBuffer = await streamTTS(trimmed);
        console.log("🔊 audio size:", audioBuffer.byteLength);
        sendAssistantAudio(audioBuffer);
      }

      for await (const chunk of llmStream) {
        if (!isSpeaking) break;
        if (phase === "done") break;
        if (!allowAudioOut) break;
        fullAssistant += chunk;
        buffer += chunk;

        if (shouldFlushTtsSegment(buffer, isFirstSegment)) {
          const toSynth = buffer;
          buffer = "";
          isFirstSegment = false;
          await flushTtsSegment(toSynth);
        }
      }

      if (buffer.trim()) {
        await flushTtsSegment(buffer);
      }

      const trimmed = fullAssistant.trim();
      if (trimmed) {
        transcriptHistory.push({
          role: "assistant",
          text: trimmed,
          at: Date.now(),
        });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "transcript_final",
              speaker: "assistant",
              text: trimmed,
              ts: Date.now(),
            }),
          );
        }
      }
    } catch (err) {
      console.error("❌ LLM/TTS Error:", err.message);
    } finally {
      isLLMRunning = false;
    }
  }

  // ===================== AUDIO + CONTROL =====================
  ws.on("message", (message, isBinary) => {
    const control = tryParseControlPayload(message, isBinary);
    if (control) {
      handleControlMessage(control).catch((err) =>
        console.error("control handler:", err)
      );
      return;
    }

    const size = message?.length || 0;
    console.log(`📦 [${id}] size:`, size);

    try {
      if (size < 1000) return;
      if (!firstPcmReceivedLogged) {
        firstPcmReceivedLogged = true;
        console.log(`[${id}] first PCM received`);
      }

      if (phase !== "live" || interviewDeadlinePassed()) return;
      if (!(transportState === "UPLINK_READY" || transportState === "LIVE")) {
        earlyPcmDroppedCount += 1;
        console.log(
          `[${id}] EARLY_PCM_DROPPED state=${transportState} count=${earlyPcmDroppedCount}`,
        );
        return;
      }

      if (sttOpen && sttStream && sttStream.readyState === WebSocket.OPEN) {
        sttStream.sendAudio?.(message);
        if (!firstPcmForwardedLogged) {
          firstPcmForwardedLogged = true;
          console.log(`[${id}] first PCM forwarded`);
        }
        if (transportState === "UPLINK_READY") {
          setTransportState("LIVE", "first_pcm_forwarded");
        }
      } else {
        earlyPcmDroppedCount += 1;
        console.log(
          `[${id}] EARLY_PCM_DROPPED state=${transportState} reason=stt_not_writable count=${earlyPcmDroppedCount}`,
        );
      }
    } catch (err) {
      console.error("WS error:", err);
    }
  });

  // ===================== TRANSCRIPT =====================
  function onTranscript(text, isFinal) {
    if (!isFinal) return;
    if (phase !== "live") return;
    if (interviewDeadlinePassed()) return;

    const cleanText = text.trim();
    if (!cleanText) return;

    if (cleanText.length < MIN_USER_TRANSCRIPT_CHARS) {
      console.log("⏳ Transcript too short, ignoring");
      return;
    }

    userPendingUtterance = userPendingUtterance
      ? `${userPendingUtterance} ${cleanText}`.trim()
      : cleanText;
    lastUserSpeechAt = Date.now();
    scheduleUserUtteranceFlush();
  }

  ws.on("close", (code, reasonBuf) => {
    const reason = Buffer.isBuffer(reasonBuf)
      ? reasonBuf.toString("utf8")
      : String(reasonBuf || "");
    console.log(
      `🔴 Client ${id} disconnected (code=${code}, reason=${reason || "n/a"})`,
    );
    clearInterviewTimers();
    clearTimeout(reconnectSttTimer);

    if (!interviewFinalized && (phase === "live" || phase === "closing")) {
      finalizeInterview("disconnect").then(() => {
        console.log(`disconnect finalized for session=${sessionId}`);
      });
    }

    try {
      sttStream?.safeClose?.();
    } catch (err) {
      console.error("Cleanup error:", err.message);
    }
  });
});

process.on("uncaughtException", (err) => {
  console.error("🔥 Uncaught:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("🔥 Unhandled:", err);
});
