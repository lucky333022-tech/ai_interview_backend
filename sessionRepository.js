import { getSupabaseAdminClient, isSupabaseConfigured } from "./supabaseClient.js";

const SESSION_TABLE = "interview_sessions";
const RESULT_TABLE = "interview_results";

function nowIso() {
  return new Date().toISOString();
}

function requireSupabaseClient(opName) {
  if (!isSupabaseConfigured()) {
    throw new Error(
      `${opName}: Supabase is not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).`,
    );
  }
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    throw new Error(`${opName}: failed to initialize Supabase client.`);
  }
  return supabase;
}

function generateSid(prefix = "iv") {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`;
}

export async function createInterviewSession(payload) {
  const supabase = requireSupabaseClient("createInterviewSession");

  const createdAt = payload.started_at || nowIso();
  const expiresAt =
    payload.expires_at ||
    new Date(Date.parse(createdAt) + (payload.duration_ms || 10 * 60 * 1000)).toISOString();
  const row = {
    sid: payload.sid || generateSid(),
    candidate_name: payload.user_name,
    phone: payload.phone_number,
    category: payload.category,
    module: payload.module || "ai-interview",
    jd_id: payload.jd_id || null,
    created_at: createdAt,
    expires_at: expiresAt,
    used_at: payload.used_at || null,
  };

  const { data, error } = await supabase
    .from(SESSION_TABLE)
    .insert(row)
    .select("*")
    .single();
  if (error) throw new Error(`createInterviewSession: ${error.message}`);
  return data;
}

export async function updateInterviewSession(sessionId, patch) {
  if (!sessionId) return null;
  const supabase = requireSupabaseClient("updateInterviewSession");
  const row = {};
  if (patch.category !== undefined) row.category = patch.category;
  if (patch.module !== undefined) row.module = patch.module;
  if (patch.jd_id !== undefined) row.jd_id = patch.jd_id;
  if (patch.used_at !== undefined) row.used_at = patch.used_at;
  if (patch.expires_at !== undefined) row.expires_at = patch.expires_at;
  if (patch.candidate_name !== undefined) row.candidate_name = patch.candidate_name;
  if (patch.phone !== undefined) row.phone = patch.phone;
  if (Object.keys(row).length === 0) return null;

  const { data, error } = await supabase
    .from(SESSION_TABLE)
    .update(row)
    .eq("sid", sessionId)
    .select("*")
    .single();
  if (error) throw new Error(`updateInterviewSession: ${error.message}`);
  return data;
}

export async function upsertInterviewResult(sessionId, payload) {
  if (!sessionId) return null;
  const supabase = requireSupabaseClient("upsertInterviewResult");
  const evaluation = payload.evaluation || {};
  const transcriptHistory = Array.isArray(payload.transcriptHistory)
    ? payload.transcriptHistory
    : [];
  const transcriptText = transcriptHistory
    .map((e) => {
      const who = e?.role === "user" ? "Candidate" : "Interviewer_AI";
      const text = String(e?.text || "").trim();
      return text ? `${who}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
  const artifactMessages = {
    breakdown: evaluation.breakdown || null,
    strengths: Array.isArray(evaluation.strengths) ? evaluation.strengths : [],
    improvements: Array.isArray(evaluation.improvements) ? evaluation.improvements : [],
    evaluation_payload: evaluation,
    transcript_history: transcriptHistory,
    model_provider: payload.modelProvider ?? null,
    model_name: payload.modelName ?? null,
  };

  const row = {
    call_id: sessionId,
    user_id: payload.user_id || payload.phone_number || sessionId,
    category: payload.category,
    module: payload.module || "ai-interview",
    transcript: transcriptText || null,
    artifact_messages: artifactMessages,
    score: evaluation.score ?? null,
    summary: evaluation.summary ?? null,
    evaluation_source: "llm",
    ended_reason: payload.reason ?? null,
    candidate_name: payload.user_name ?? null,
    phone: payload.phone_number ?? null,
    jd_id: payload.jd_id ?? null,
    updated_at: nowIso(),
  };

  const { data, error } = await supabase
    .from(RESULT_TABLE)
    .upsert(row, { onConflict: "call_id" })
    .select("*")
    .single();
  if (error) throw new Error(`upsertInterviewResult: ${error.message}`);
  return data;
}

