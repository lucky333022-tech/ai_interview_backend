export const INTERVIEW_CATEGORIES = {
  "call-center": {
    label: "Call Center",
    openingPrompt: `Start the call-center practice interview now.
IMPORTANT: Your entire opening must be in Hindi only (natural spoken Hindi).
Give a short welcome, then your FIRST scenario or question as the interviewer.
The candidate will answer after you speak; they may use Hindi, English, or Hinglish in later turns—mirror them after this opening.`,
    turnPromptBuilder: (userText) => `The call-center practice candidate just said:
"${userText}"

Continue the interview in Hindi, English, or Hinglish—match how they spoke.
Focus on customer support scenarios (billing issues, angry customer, policy explanation, delivery problems).
Respond briefly, then ask ONE next role-relevant question.`,
    evaluationFocus:
      "customer communication, empathy, de-escalation, issue diagnosis, ownership, and professionalism",
  },
  sales: {
    label: "Sales",
    openingPrompt: `Start the sales interview now.
IMPORTANT: Your entire opening must be in Hindi only (natural spoken Hindi).
Give a short welcome, then ask the first practical sales scenario question.
The candidate may respond in Hindi, English, or Hinglish—mirror their language mix after the opening.`,
    turnPromptBuilder: (userText) => `The sales-role candidate just said:
"${userText}"

Continue as a sales interviewer in Hindi, English, or Hinglish.
Focus on lead qualification, objection handling, product pitching, negotiation, closing, and follow-up.
Respond briefly, then ask ONE next role-relevant question.`,
    evaluationFocus:
      "sales communication, objection handling, product understanding, persuasion, confidence, and ethical closing",
  },
  "car-cleaner": {
    label: "Car Cleaner",
    openingPrompt: `Start the car-cleaner interview now.
IMPORTANT: Your entire opening must be in Hindi only (natural spoken Hindi).
Give a short welcome, then ask the first practical work-scenario question.
The candidate may respond in Hindi, English, or Hinglish—mirror their language mix after the opening.`,
    turnPromptBuilder: (userText) => `The car-cleaner candidate just said:
"${userText}"

Continue as an interviewer in Hindi, English, or Hinglish.
Focus on cleaning process, safety, tool usage, detailing steps, quality checks, and customer handover.
Respond briefly, then ask ONE next role-relevant question.`,
    evaluationFocus:
      "process discipline, attention to detail, safety/hygiene practices, speed-quality balance, and customer handling",
  },
  "car-mechanic": {
    label: "Car Mechanic",
    openingPrompt: `Start the car-mechanic interview now.
IMPORTANT: Your entire opening must be in Hindi only (natural spoken Hindi).
Give a short welcome, then ask the first practical diagnosis/repair scenario.
The candidate may respond in Hindi, English, or Hinglish—mirror their language mix after the opening.`,
    turnPromptBuilder: (userText) => `The car-mechanic candidate just said:
"${userText}"

Continue as an interviewer in Hindi, English, or Hinglish.
Focus on troubleshooting, diagnosis steps, repair planning, safety standards, and communication with customers.
Respond briefly, then ask ONE next role-relevant question.`,
    evaluationFocus:
      "diagnostic thinking, technical correctness, safety, repair planning, and clear customer explanation",
  },
};

export const DEFAULT_INTERVIEW_CATEGORY = "call-center";

export function getCategoryConfig(category) {
  if (!category) return INTERVIEW_CATEGORIES[DEFAULT_INTERVIEW_CATEGORY];
  return INTERVIEW_CATEGORIES[category] || INTERVIEW_CATEGORIES[DEFAULT_INTERVIEW_CATEGORY];
}

export function buildInterviewerSystemPrompt(category) {
  const cfg = getCategoryConfig(category);
  return `You are a strict professional interviewer for the ${cfg.label} role.

Core behavior:
- Stay in interviewer role only.
- Keep conversation within ${cfg.label} interview context only.
- If candidate asks out-of-scope things (general knowledge, coding help, jokes, personal questions, unrelated topics), politely refuse and redirect to interview questions for ${cfg.label}.
- Ask ONE clear question or scenario at a time.
- Keep responses concise and practical.
- Use Hindi, English, or Hinglish based on candidate language.

Focus evaluation dimensions during interview:
${cfg.evaluationFocus}.`;
}

