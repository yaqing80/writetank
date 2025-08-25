// for API calls and timers

// WriteTank — Background Service Worker (MV3)
// - Stores settings (endpoint, model, interval, paused)
// - Handles Q&A and Auto-coach requests
// - Talks to Ollama API from the background (avoids CORS)
// - Triggers periodic "coach" runs via chrome.alarms

type Settings = {
    endpoint: string; // e.g. http://localhost:11434
    model: string;    // e.g. gpt-oss:20b (swap to mistral:instruct during dev)
    intervalMin: number; // 5–15 sensible range
    paused: boolean;
  };
  
  const DEFAULTS: Settings = {
    endpoint: 'http://localhost:11434',
    model: 'gpt-oss:20b',
    intervalMin: 5,
    paused: true, // user opts in
  };
  
  const QA_PROMPT = (context: string, question: string) => `
  Answer directly and only with the final result (no reasoning).
  Respond in LaTeX. Keep to ≤10 lines.
  Prefer \\begin{itemize}...\\end{itemize} or \\paragraph{} where suitable.
  Use \\cite{TODO} and \\ref{TODO} placeholders if needed.
  
  Context:
  ${context}
  
  Question:
  ${question}
  
  Answer (LaTeX only):
  `.trim();
  
  const COACH_PROMPT = (snippet: string) => `
  No reasoning. Return these exact blocks in LaTeX:
  
  1) \\paragraph{Structure} One sentence describing the recommended paragraph plan.
  2) \\begin{itemize} 3–6 concrete details to add \\end{itemize}
  3) A polished paragraph (≤12 lines).
  
  Flag missing \\label/\\ref/\\cite with TODO placeholders.
  
  Snippet:
  ${snippet}
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
  
  async function callOllama(prompt: string): Promise<string> {
    const { endpoint, model } = await getSettings();
    const url = `${endpoint.replace(/\/$/, '')}/api/generate`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        keep_alive: '30m',
        options: {
          num_predict: 200,
          num_ctx: 2048,
          temperature: 0.2,
          top_p: 0.9,
          repeat_penalty: 1.1,
        },
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return data?.response ?? '';
  }
  
  async function getActiveOverleafTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({
      url: '*://www.overleaf.com/*',
      active: true,
      currentWindow: true,
    });
    return tabs[0] ?? null;
  }
  
  // --- Lifecycle: initialize defaults & alarm
  chrome.runtime.onInstalled.addListener(async () => {
    await setSettings({}); // write defaults if missing
    await ensureAlarm();
  });
  chrome.runtime.onStartup.addListener(ensureAlarm);
  
  // --- Messaging
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
        const { text, question } = msg;
        try {
          const ans = await callOllama(QA_PROMPT(text ?? '', question ?? ''));
          sendResponse({ ok: true, text: ans });
        } catch (e: any) {
          sendResponse({ ok: false, error: e?.message || 'Model error' });
        }
        return;
      }
      if (msg?.cmd === 'coach') {
        const { text } = msg;
        try {
          const out = await callOllama(COACH_PROMPT(text ?? ''));
          sendResponse({ ok: true, text: out, updatedAt: Date.now() });
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
      if (msg?.cmd === 'run-now') {
        // ask the active Overleaf tab to provide a snippet, then run coach
        const tab = await getActiveOverleafTab();
        if (!tab?.id) return sendResponse({ ok: false, error: 'No Overleaf tab' });
        const sample = await chrome.tabs.sendMessage(tab.id, { cmd: 'grabText' }).catch(() => null);
        if (!sample?.text) return sendResponse({ ok: false, error: 'No text' });
        try {
          const out = await callOllama(COACH_PROMPT(sample.text));
          await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:answer', text: out, updatedAt: Date.now() });
          sendResponse({ ok: true });
        } catch (e: any) {
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
    const sample = await chrome.tabs.sendMessage(tab.id, { cmd: 'grabText' }).catch(() => null);
    if (!sample?.text) return;
    try {
      const out = await callOllama(COACH_PROMPT(sample.text));
      await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:answer', text: out, updatedAt: Date.now() });
    } catch {
      // silently ignore on tick
    }
  });