import { DEFAULT_INTERVIEW_SYSTEM_PROMPT } from "./interviewSystemPrompt.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/**
 * OpenAI Chat Completions streaming (SSE). Same shape as Groq for server.js.
 * Default model: gpt-4o-mini — fast TTFT, good for short conversational turns.
 * Override with OPENAI_MODEL (e.g. gpt-4o for higher quality, slightly slower).
 */
export async function streamLLM(prompt, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY in environment");
  }

  const model =
    process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const systemPrompt =
    options.systemPrompt?.trim() || DEFAULT_INTERVIEW_SYSTEM_PROMPT;

  async function* streamGeneratorLive() {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
        max_tokens: 300,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenAI stream error:", response.status, errText);
      throw new Error("OpenAI API error");
    }

    // it is like , give me the data one by one
    const reader = response.body?.getReader();
    if (!reader) throw new Error("OpenAI response has no body");


    // convert binary (uint8array) to text
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let assembled = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.delta?.content;
          if (content) {
            assembled += content;
            yield content;
          }
        } catch {
          /* incomplete JSON line */
        }
      }
    }

    if (sseBuffer.trim()) {
      const trimmed = sseBuffer.trim();
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        if (data !== "[DONE]") {
          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              assembled += content;
              yield content;
            }
          } catch {
            /* ignore */
          }
        }
      }
    }

    console.log("text response from OpenAI (streamed):", assembled);
  }

  return streamGeneratorLive();
}
