// ===================== server.js (CALL CENTER INTERVIEW) =====================
import WebSocket, { WebSocketServer } from "ws";
import { createElevenLabsSttStream } from "./elevenlabsStt.js";
import { streamLLM } from "./openai.js";
import { streamTTS } from "./tts.js";
import { evaluateInterview } from "./evaluateInterview.js";
import {
  DEFAULT_INTERVIEW_CATEGORY,
  INTERVIEW_CATEGORIES,
  buildInterviewerSystemPrompt,
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

const wss = new WebSocketServer({ port: 3000 });

const INTERVIEW_MS = 10 * 60 * 1000;
const WARNING_BEFORE_END_MS = 60 * 1000;

console.log("🚀 Server running on ws://localhost:3000");

let connectionId = 0;

function validateStartPayload(obj) {
  const category = String(obj?.category || "").trim().toLowerCase();
  const userName = String(obj?.user_name || "").trim();
  const phoneNumber = String(obj?.phone_number || "").trim();

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
  console.log(`🟢 Client ${id} connected`);

  let isSpeaking = false;
  let sttStream = null;
  let sttOpen = false;
  let sessionId = null;
  let interviewCategory = DEFAULT_INTERVIEW_CATEGORY;
  let sessionUserName = "";
  let sessionPhoneNumber = "";

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

  function getTurnPrompt(userText) {
    const cfg = getCategoryConfig(interviewCategory);
    return cfg.turnPromptBuilder(userText);
  }

  function getOpeningPrompt() {
    return getCategoryConfig(interviewCategory).openingPrompt;
  }

  function getInterviewSystemPrompt() {
    return buildInterviewerSystemPrompt(interviewCategory);
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
      }
    } finally {
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
        "Your interview time is up. Thank you for participating.";
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
      userPendingUtterance = "";
      lastUserSpeechAt = 0;
      lastInterimTranscript = "";
      clearUserUtteranceDebounce();
      phase = "live";
      interviewStartedAt = Date.now();
      interviewCategory = input.category;
      sessionUserName = input.user_name;
      sessionPhoneNumber = input.phone_number;

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

      armInterviewTimers();

      const endsAt = interviewStartedAt + INTERVIEW_MS;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "interview_started",
            endsAt,
            session_id: sessionId,
            category: interviewCategory,
            user_name: sessionUserName,
            phone_number: sessionPhoneNumber,
          }),
        );
        ws.send(JSON.stringify({ type: "transcript_reset" }));
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

      await runAssistantTurn(getOpeningPrompt());
      return;
    }

    if (obj.type === "end_interview") {
      if (phase !== "live" && phase !== "closing") return;
      allowAudioOut = false;
      isSpeaking = false;
      assistantPlaybackUntil = 0;
      phase = "closing";
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
      if (!sttStream) {
        console.log(`🚀 Creating ${STT_PROVIDER} STT stream...`);

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
          // Only stop TTS when assistant audio is actually playing — not merely while
          // the LLM is generating (avoids false barge-in when the user continues after a short STT split).
          const playbackActive =
            phase === "live" && Date.now() < assistantPlaybackUntil;
          if (!playbackActive) return;
          console.log(`🎤 [${id}] Barge-in (user speaking over assistant)`);
          handleUserBargeIn();
        });

        sttStream.on("open", () => {
          sttOpen = true;
          console.log(`🧠 ${STT_PROVIDER} connected (client ${id})`);
        });

        sttStream.on("close", () => {
          sttOpen = false;
          sttStream = null;
          console.log(`❌ ${STT_PROVIDER} closed (client ${id})`);
        });

        sttStream.on("error", (err) => {
          console.error(`${STT_PROVIDER} error:`, err.message);
        });
      }

      if (size < 1000) return;

      if (phase !== "live" || interviewDeadlinePassed()) return;

      if (sttOpen && sttStream.readyState === WebSocket.OPEN) {
        if (typeof sttStream.sendAudio === "function") {
          sttStream.sendAudio(message);
        } else {
          sttStream.send(message);
        }
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

  ws.on("close", () => {
    console.log(`🔴 Client ${id} disconnected`);
    clearInterviewTimers();

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
