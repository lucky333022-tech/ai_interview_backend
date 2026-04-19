import { getCategoryConfig } from "./interviewCategories.js";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const CORE_EVAL_SYSTEM = `You are evaluating a voice interview transcript for a training module assessment.

## Scoring guidelines
- Score each distinct question the Assistant asked. Per-question points (0-10):
  - Great answer: 10 points
  - Good answer: 7-8 points
  - Okay answer: 4-6 points
  - Poor / wrong / no answer: 0-3 points
- Final score (0-100): (sum of per-question scores / number of questions) × 10, rounded to integer.
  - Example: 1 question with a great answer → 10/1 × 10 = 100.
  - Example: 3 questions with scores 10, 7, 4 → (10+7+4)/3 × 10 ≈ 70.
- If the transcript is empty or has no real Q&A (e.g. only greetings, no question answered), score 0.
- If the candidate answered at least one question (even briefly), do NOT score 0. Assign points per question and compute the final 0-100 score.

Respond with a JSON object only, no other text:
{
  "score": <number 0-100>,
  "summary": "<brief assessment: strengths and areas for improvement in 2-4 sentences>"
}`;

function extractJsonObject(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param {Array<{ role: string, text: string, at?: number }>} transcriptHistory
 * @param {string} reason - 'manual' | 'timeout' | 'disconnect'
 * @param {string} category
 * @returns {Promise<{ score: number, breakdown: object, summary: string, strengths: string[], improvements: string[] } | { error: string }>}
 */
const MIN_USER_CHARS = 8;

function hasSubstantiveUserReply(transcriptHistory) {
  const userTurns = transcriptHistory.filter((e) => e.role === "user");
  if (userTurns.length === 0) return false;
  return userTurns.some((e) => (e.text || "").trim().length >= MIN_USER_CHARS);
}

export async function evaluateInterview(
  transcriptHistory,
  reason = "manual",
  category = "call-center",
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { error: "Missing OPENAI_API_KEY" };
  }
  const evalModel = process.env.OPENAI_EVAL_MODEL || "gpt-4o-mini";

  if (!hasSubstantiveUserReply(transcriptHistory)) {
    return {
      score: 0,
      breakdown: null,
      summary:
        "No scored responses: the candidate did not answer the interview questions (or replies were too short). Score is 0. Start again and respond when the interviewer asks.",
      strengths: [],
      improvements: [
        "Answer each question in full sentences when you are ready to be evaluated.",
      ],
    };
  }

  const lines = transcriptHistory.map((e) => {
    const who = e.role === "user" ? "Candidate" : "Interviewer_AI";
    return `${who}: ${e.text}`;
  });
  const cfg = getCategoryConfig(category);
  const evalSystem = `${CORE_EVAL_SYSTEM}

Interview category: ${cfg.label}
Category focus: ${cfg.evaluationFocus}
Penalize irrelevant/off-topic answers that are not aligned with this category.`;

  const transcriptText =
    lines.length > 0
      ? lines.join("\n")
      : "(No conversation captured.)";

  const userContent = `Interview ended: ${reason}

Transcript:
${transcriptText}

Return only the JSON object as specified.`;

  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: evalModel,
        messages: [
          { role: "system", content: evalSystem },
          { role: "user", content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      console.error("Eval OpenAI error:", res.status, t);
      return { error: "Evaluation service error" };
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(raw);
    if (!parsed || typeof parsed.score !== "number") {
      console.error("Eval parse failed, raw:", raw.slice(0, 500));
      return { error: "Could not parse evaluation" };
    }

    const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
    return {
      score,
      breakdown: null,
      summary: String(parsed.summary || ""),
      strengths: [],
      improvements: [],
    };
  } catch (err) {
    console.error("evaluateInterview:", err);
    return { error: err.message || "Evaluation failed" };
  }
}
