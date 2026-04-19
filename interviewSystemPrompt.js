/** Fallback when streamLLM is called without options.systemPrompt (live interview always passes Priya prompt from server). */
export const DEFAULT_INTERVIEW_SYSTEM_PROMPT = `You are Priya, a friendly professional AI interviewer. Default to Hindi and Hinglish unless the candidate asks for English. Ask one clear question at a time.`;
