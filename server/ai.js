// Optional AI helpers backed by a local Colibri server (or any OpenAI-compatible
// endpoint). Enabled only when AI_BASE_URL is set, e.g. http://10.0.0.5:8000/v1.
// AI is advisory: it never sits in the SOS path, never blocks or closes an
// incident, and never receives exact coordinates or phone numbers.
export function createAi(env, { fetchImpl = fetch } = {}) {
  const base = (env.AI_BASE_URL || '').replace(/\/$/, '');
  if (!base) return null;
  const model = env.AI_MODEL || 'qwen3.6-35b-a3b';
  async function chat(system, user, { maxTokens = 400, temperature = 0.2 } = {}) {
    try {
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout ? AbortSignal.timeout(Number(env.AI_TIMEOUT_MS) || 45000) : undefined,
        headers: { 'Content-Type': 'application/json', ...(env.AI_API_KEY ? { Authorization: `Bearer ${env.AI_API_KEY}` } : {}) },
        body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!res.ok) return null;
      const j = await res.json();
      return String(j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;
    } catch { return null; }
  }
  const json = (txt) => { try { return JSON.parse(String(txt).match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return null; } };
  return {
    model,
    async incidentSummary(facts) {
      const out = await chat(
        'You assist a women\'s-safety operations operator. Given incident facts, write: 1) a 2-sentence situation summary, 2) up to 4 concrete next steps for the OPERATOR (e.g. phone 112, reassign a stalled responder, call the woman back unless duress). Never suggest confronting anyone. Never invent facts. Plain text, short.',
        JSON.stringify(facts), { maxTokens: 350 });
      return out ? { text: out, model, at: new Date().toISOString() } : null;
    },
    async translate(text, targetLang) {
      const out = await chat(`Translate the user's text into ${targetLang}. Output only the translation.`, String(text).slice(0, 2000), { maxTokens: 600, temperature: 0 });
      return out;
    },
    async riskAssessment(kind, text, context = {}) {
      const out = await chat(
        'You help a safety team triage reports. Classify the text. Reply ONLY with JSON: {"risk":"LOW|MEDIUM|HIGH","category":"genuine|prank_or_test|abusive_language|harassment_report|spam|unclear","reason":"<one short sentence>"}. When unsure, choose LOW and "unclear". A real emergency must never be labelled prank without clear evidence.',
        JSON.stringify({ kind, text: String(text || '').slice(0, 1500), context }), { maxTokens: 120, temperature: 0 });
      const j = json(out);
      if (!j || !['LOW', 'MEDIUM', 'HIGH'].includes(j.risk)) return null;
      return { risk: j.risk, category: String(j.category || 'unclear').slice(0, 30), reason: String(j.reason || '').slice(0, 200), model, at: new Date().toISOString(), advisory: true };
    },
  };
}
