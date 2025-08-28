// for API calls and timers

// WriteTank — Background Service Worker (MV3)
// - Stores settings (endpoint, model, interval, paused)
// - Handles Q&A and Auto-coach requests
// - Talks to Ollama API from the background (avoids CORS)
// - Triggers periodic "coach" runs via chrome.alarms

type Settings = {
    endpoint: string; // e.g. http://localhost:11434
    model: string;    // e.g. gpt-oss:20b
    intervalMin: number; // 5–15 sensible range
    paused: boolean;
  };
  
  const DEFAULTS: Settings = {
    endpoint: 'http://localhost:11434',
    model: 'gpt-oss:20b',
    intervalMin: 5,
    paused: true, // user opts in
  };
  
  // --- System prompt (short = faster, stricter)
  const SYSTEM_PROMPT = `
  You are WriteTank, a local LaTeX writing assistant.
  - Do NOT show reasoning.
  - For LaTeX questions: output LaTeX code.
  - For content questions: answer naturally.
  - Keep answers concise (≤10 lines).
  - Prefer \\paragraph{} and \\begin{itemize}...\\end{itemize}, but only use LaTeX format if needed to.
  - Make sure syntax and grammar are correct.
  - If an answer started with \\begin{itemize}, make sure it ends with \\end{itemize}.
  - Use \\cite{TODO} / \\ref{TODO} placeholders when needed.
  `.trim();
  
  // --- User prompts
  const QA_PROMPT = (context: string, question: string) => `
  Context:
  ${context}
  
  Question:
  ${question}
  
  If the question is about LaTeX formatting, output LaTeX code.
  If the question is about the content or meaning, answer naturally.
  Keep answers concise (≤10 lines).
  `.trim();
  
  const COACH_PROMPT = (snippet: string) => `
  You are a concise writing coach. Do NOT rewrite the text. Do NOT output full sentences of the user's content. Provide guidance and actionable suggestions only.
  
  Snippet (context for coaching; do not quote it back):
  ${snippet}
  
  Return exactly, using LaTeX where indicated:
  1) \\paragraph{Structure} One-sentence assessment of organization (no rewriting).
  2) \\begin{itemize}
     \\item 3–6 actionable improvement suggestions (clarity, flow, redundancy, active voice, cohesion)
     \\item Mention where to add \\label/\\ref/\\cite as TODO if missing
     \\item Suggest section-level moves (e.g., "define key term earlier", "split long paragraph")
  \\end{itemize}
  3) \\paragraph{Checklist} 4–6 yes/no checks (e.g., "All acronyms defined on first use?")
  
  Constraints:
  - Do not reproduce or paraphrase user sentences.
  - No full rewrites. Keep feedback high-signal and brief (≤12 lines total).
  - If the snippet already reads clearly, is well-organized, and requires no edits,
    then explicitly say so and provide positive confirmation instead of forcing issues.
    In that case, still return the three sections above, where the itemized list
    contains 1–3 lightweight polish suggestions or "No changes needed" entries,
    and the checklist answers mostly "Yes" where appropriate.
  `.trim();
  
  // --- Utilities
  
  async function getSettings(): Promise<Settings> {
    const s = await chrome.storage.local.get(DEFAULTS);
    return { ...DEFAULTS, ...s };
  }
  async function setSettings(patch: Partial<Settings>) {
    const prev = await getSettings();
    await chrome.storage.local.set({ ...prev, ...patch });
    await ensureAlarm();
  }
  
  async function ensureAlarm() {
    const { paused, intervalMin } = await getSettings();
    await chrome.alarms.clear('writetank:tick');
    if (!paused && intervalMin > 0) {
      chrome.alarms.create('writetank:tick', { periodInMinutes: intervalMin });
    }
  }
  
  // Trim incoming text to keep latency under control
  function trimChars(s: string, max = 1500) {
    if (!s) return '';
    return s.length > max ? s.slice(0, max) : s;
  }
  
  // Chat call with system prompt + strict caps
  async function ollamaChat({
    system,
    user,
    numPredict = 180,
    numCtx = 2048,
  }: {
    system: string;
    user: string;
    numPredict?: number;
    numCtx?: number;
  }): Promise<string> {
    const { endpoint, model } = await getSettings();
    const url = `${endpoint.replace(/\/$/, '')}/api/chat`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        keep_alive: '30m',
        options: {
          num_predict: numPredict,  // hard cap output tokens
          num_ctx: numCtx,          // keep modest for speed
          temperature: 0.2,
          top_p: 0.9,
          repeat_penalty: 1.1,
          // Optional stop sequences to cut tails
          stop: ["\\end{itemize}\n\n", "\n\n\n"]
        },
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return data?.message?.content ?? '';
  }
  
  async function getActiveOverleafTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({
      url: '*://www.overleaf.com/*',
      active: true,
      currentWindow: true,
    });
    return tabs[0] ?? null;
  }
  
  // --- Lifecycle
  chrome.runtime.onInstalled.addListener(async () => {
    await setSettings({}); // write defaults if missing
    await ensureAlarm();
  });
  chrome.runtime.onStartup.addListener(ensureAlarm);
  
  // --- Messaging
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.cmd === 'settings:get') {
        sendResponse(await getSettings());
        return;
      }
      if (msg?.cmd === 'settings:set') {
        await setSettings(msg.patch || {});
        sendResponse({ ok: true });
        return;
      }
      if (msg?.cmd === 'qa') {
        const context = trimChars(msg?.text ?? '', 1500);
        const question = (msg?.question ?? '').trim();
        console.log('QA Request:', { context: context.substring(0, 100), question });
        try {
          const ans = await ollamaChat({
            system: SYSTEM_PROMPT,
            user: QA_PROMPT(context, question),
            numPredict: 180,
            numCtx: 2048,
          });
          console.log('QA Answer:', ans);
          sendResponse({ ok: true, text: ans });
        } catch (e: any) {
          console.error('QA Error:', e);
          sendResponse({ ok: false, error: e?.message || 'Model error' });
        }
        return;
      }
      if (msg?.cmd === 'coach') {
        const snippet = trimChars(msg?.text ?? '', 1500);
        try {
          const out = await ollamaChat({
            system: SYSTEM_PROMPT,
            user: COACH_PROMPT(snippet),
            numPredict: 220,
            numCtx: 2048,
          });
          const safeOut = (out && out.trim()) ? out : 'No substantial issues detected. Keep going!';
          sendResponse({ ok: true, text: safeOut, updatedAt: Date.now() });
        } catch (e: any) {
          sendResponse({ ok: false, error: e?.message || 'Model error' });
        }
        return;
      }
      if (msg?.cmd === 'ping-endpoint') {
        try {
          const { endpoint } = await getSettings();
          const r = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`);
          sendResponse({ ok: r.ok });
        } catch {
          sendResponse({ ok: false });
        }
        return;
      }
      if (msg?.cmd === 'test-model') {
        try {
          const ans = await ollamaChat({
            system: "You are a helpful assistant. Answer briefly.",
            user: "What is 2+2?",
            numPredict: 50,
            numCtx: 512,
          });
          sendResponse({ ok: true, text: ans });
        } catch (e: any) {
          sendResponse({ ok: false, error: e?.message || 'Model error' });
        }
        return;
      }
      if (msg?.cmd === 'run-now') {
        const tab = await getActiveOverleafTab();
        if (!tab?.id) { sendResponse({ ok: false, error: 'No Overleaf tab' }); return; }
        // Prefer visible area for coaching
        await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: 'Scanning visible text…' }).catch(() => {});
        let sample = await chrome.tabs.sendMessage(tab.id, { cmd: 'grabText', mode: 'visible' }).catch(() => null);
        let source = 'visible';
        if (!sample?.text) {
          // Fallback to full editor text
          sample = await chrome.tabs.sendMessage(tab.id, { cmd: 'grabText' }).catch(() => null);
          source = 'fallback-full';
        }
        if (!sample?.text) { sendResponse({ ok: false, error: 'No text' }); return; }
        await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: `Read ${sample.text.length} chars from ${source === 'visible' ? 'visible area' : 'full editor'}…` }).catch(() => {});
        try {
          await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: 'Thinking…' }).catch(() => {});
          const out = await ollamaChat({
            system: SYSTEM_PROMPT,
            user: COACH_PROMPT(trimChars(sample.text, 1500)),
            numPredict: 220,
            numCtx: 2048,
          });
          const safeOut = (out && out.trim()) ? out : 'No substantial issues detected. Keep going!';
          await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:answer', text: safeOut, updatedAt: Date.now() });
          sendResponse({ ok: true });
        } catch (e: any) {
          await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: `(error) ${e?.message || 'Model error'}` }).catch(() => {});
          sendResponse({ ok: false, error: e?.message || 'Model error' });
        }
        return;
      }
    })();
    return true; // keep channel open for async sendResponse
  });
  
  // --- Alarm tick → auto-coach
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'writetank:tick') return;
    const { paused } = await getSettings();
    if (paused) return;
    const tab = await getActiveOverleafTab();
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: 'Scanning visible text…' }).catch(() => {});
    let sample: any = await chrome.tabs.sendMessage(tab.id, { cmd: 'grabText', mode: 'visible' }).catch(() => null);
    let source = 'visible';
    if (!sample?.text) {
      sample = await chrome.tabs.sendMessage(tab.id, { cmd: 'grabText' }).catch(() => null);
      source = 'fallback-full';
    }
    if (!sample?.text) return;
    await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: `Read ${sample.text.length} chars from ${source === 'visible' ? 'visible area' : 'full editor'}…` }).catch(() => {});
    try {
      await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: 'Thinking…' }).catch(() => {});
      const out = await ollamaChat({
        system: SYSTEM_PROMPT,
        user: COACH_PROMPT(trimChars(sample.text, 1500)),
        numPredict: 220,
        numCtx: 2048,
      });
      const safeOut = (out && out.trim()) ? out : 'No substantial issues detected. Keep going!';
      await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:answer', text: safeOut, updatedAt: Date.now() });
    } catch {
      // silently ignore on tick, but try to inform UI
      await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: '(error) Model unavailable' }).catch(() => {});
    }
  });