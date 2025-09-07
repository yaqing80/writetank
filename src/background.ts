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
  - CRITICAL: If an answer starts with \\begin{itemize}, it MUST end with \\end{itemize}.
  - CRITICAL: All LaTeX environments must be properly closed.
  - CRITICAL: Always verify that every \\begin{...} has a corresponding \\end{...}.
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
  Give answers that can be copied and pasted into the Overleaf editor.
  
  CRITICAL LaTeX Rules:
  - If an answer starts with \\begin{itemize}, it MUST end with \\end{itemize}.
  - All LaTeX environments must be properly closed.
  - Ensure all LaTeX syntax is complete and valid.
  `.trim();
  
  function COACH_PROMPT(snippet: string): string {
    return `
  You are a concise writing coach. Do NOT rewrite the text. Do NOT output full sentences of the user's content. Provide guidance and actionable suggestions only.
  
  Snippet (context for coaching; do not quote it back):
  ${snippet}
  
  Return exactly, using LaTeX where indicated:
  1) \\paragraph{Structure} One-sentence assessment of organization (no rewriting).
  2) \\begin{itemize}
     \\item 3–4 actionable improvement suggestions (clarity, flow, redundancy, active voice, cohesion)
     \\item Mention where to add \\label/\\ref/\\cite as TODO if missing
     \\item Suggest section-level moves (e.g., "define key term earlier", "split long paragraph")
  \\end{itemize}
  3) \\paragraph{Checklist} 3–4 yes/no checks (e.g., "All acronyms defined on first use?")
  
  Constraints:
  - Do not reproduce or paraphrase user sentences.
  - No full rewrites. Keep feedback high-signal and brief (≤8–10 lines total).
  - If the snippet already reads clearly, is well-organized, and requires no edits,
    then explicitly say so and provide positive confirmation instead of forcing issues.
    In that case, still return the three sections above, where the itemized list
    contains 1–2 lightweight polish suggestions or "No changes needed" entries,
    and the checklist answers mostly "Yes" where appropriate.
  `.trim();
  }

  function COACH_PROMPT_EXPAND(snippet: string): string {
    return `
  You are a detailed writing coach. Produce a comprehensive LaTeX paragraph that thoroughly addresses the main issues found in the snippet. Do NOT quote or reuse the user's sentences verbatim; write generalized guidance phrased as a paragraph, not a list.
  
  Snippet:
  ${snippet}
  
  Output:
  - One comprehensive LaTeX paragraph capturing detailed suggested improvements and rationale.
  - Use TODO notes for missing \\label/\\ref/\\cite.
  - No bullets, no extra sections.
  - Do not stop in the middle of a sentence, make sure every sentence is complete.
  - Provide thorough analysis with specific, actionable feedback.
  - Always give a more detailed analysis, do not just repeat saying "well done" or "keep going".
  `.trim();
  }

  // Summarization prompt (concise, 300–500 tokens target)
  const SUMMARIZE_PROMPT = (snippet: string) => `
  You are an expert technical summarizer. Produce a concise section summary (300–500 tokens max).
  - Capture goals, claims, methods, key definitions, open TODOs.
  - Do not copy full sentences.
  - Use terse, high-signal prose or a short bullet list.

  Snippet:
  ${snippet}

  Output only the summary.
  `.trim();

  // --- Summary cache utilities
  function simpleHash(s: string): string {
    let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return String(h >>> 0);
  }
  async function getDocId(): Promise<string> {
    const tab = await getActiveOverleafTab();
    return tab?.url ? simpleHash(tab.url) : 'unknown';
  }
  type SummaryEntry = { sectionKey: string; text: string; updatedAt: number };
  async function loadSummaries(docId: string): Promise<Record<string, SummaryEntry>> {
    const k = `wt:summaries:${docId}`;
    const obj = await chrome.storage.local.get(k);
    return obj?.[k] || {};
  }
  function pickBestSummary(provided: string, summaries: Record<string, SummaryEntry>): SummaryEntry | undefined {
    const entries = Object.values(summaries);
    if (entries.length === 0) return undefined;
    const tokenize = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) || []));
    const sel = tokenize(provided);
    // If no selection text, return most recent
    if (sel.size === 0) return entries.sort((a,b) => b.updatedAt - a.updatedAt)[0];
    let best: SummaryEntry | undefined; let bestScore = -1;
    for (const e of entries) {
      const t = tokenize(e.text);
      let score = 0;
      for (const w of sel) if (t.has(w)) score++;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best || entries.sort((a,b) => b.updatedAt - a.updatedAt)[0];
  }
  async function saveSummaries(docId: string, summaries: Record<string, SummaryEntry>) {
    const k = `wt:summaries:${docId}`;
    await chrome.storage.local.set({ [k]: summaries });
  }
  async function maybeUpdateSummary(sampleText: string) {
    const docId = await getDocId();
    const sectionKey = simpleHash(sampleText.slice(0, 800));
    const summaries = await loadSummaries(docId);
    if (summaries[sectionKey]?.text) return; // already cached
    // Summarize with low predict for speed
    const summary = await ollamaChat({
      system: "You are a helpful summarizer.",
      user: SUMMARIZE_PROMPT(sampleText),
      numPredict: 120,
      numCtx: 1536,
    }).catch(() => '');
    if (summary && summary.trim()) {
      summaries[sectionKey] = { sectionKey, text: summary.trim(), updatedAt: Date.now() };
      // Cap entries per doc (keep most recent 12)
      const maxEntries = 12;
      const entries = Object.values(summaries).sort((a,b) => b.updatedAt - a.updatedAt);
      if (entries.length > maxEntries) {
        const keepSet = new Set(entries.slice(0, maxEntries).map(e => e.sectionKey));
        for (const key of Object.keys(summaries)) {
          if (!keepSet.has(key)) delete summaries[key];
        }
      }
      await saveSummaries(docId, summaries);
      // Best-effort notify active tab
      const tab = await getActiveOverleafTab();
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: 'Summary cached' }).catch(() => {});
      }
    }
  }
  
  // --- Utilities
  
  // Trim trailing partial sentence; keep up to last terminal punctuation
  function ensureCompleteSentences(text: string): string {
    if (!text) return text;
    const terminals = ['.', '!', '?'];
    let last = -1;
    for (const t of terminals) {
      const idx = text.lastIndexOf(t);
      if (idx > last) last = idx;
    }
    if (last === -1) return text;
    // Include any trailing closing quotes/brackets after terminal
    let end = last + 1;
    const closers = [')', ']', '}', '”', '’', '"', "'"];
    while (end < text.length && closers.includes(text[end])) end++;
    return text.slice(0, end).trim();
  }
  
  // Ensure LaTeX environments are properly closed
  function ensureLatexCompleteness(text: string): string {
    if (!text) return text;
    
    // Check for common LaTeX environments
    const environments = ['itemize', 'enumerate', 'description', 'equation', 'align', 'figure', 'table'];
    let result = text;
    let wasFixed = false;
    
    for (const env of environments) {
      const openPattern = new RegExp(`\\\\begin\\{${env}\\}`, 'g');
      const closePattern = new RegExp(`\\\\end\\{${env}\\}`, 'g');
      
      const openCount = (result.match(openPattern) || []).length;
      const closeCount = (result.match(closePattern) || []).length;
      
      // If we have more opening tags than closing tags, add the missing ones
      if (openCount > closeCount) {
        const missing = openCount - closeCount;
        result += '\n' + `\\end{${env}}`.repeat(missing);
        wasFixed = true;
        console.log(`WriteTank: Fixed ${missing} missing \\end{${env}} tag(s)`);
      }
    }
    
    if (wasFixed) {
      console.log('WriteTank: LaTeX completeness check completed - all environments now properly closed');
    }
    
    return result;
  }
  
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
          stop: ["\n\n\n"]
        },
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return data?.message?.content ?? '';
  }

  // Streaming chat helper
  async function ollamaChatStream({
    system,
    user,
    numPredict = 200,
    numCtx = 2048,
    onDelta,
  }: {
    system: string;
    user: string;
    numPredict?: number;
    numCtx?: number;
    onDelta: (text: string) => void;
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
        stream: true,
        keep_alive: '30m',
        options: {
          num_predict: numPredict,
          num_ctx: numCtx,
          temperature: 0.2,
          top_p: 0.9,
          repeat_penalty: 1.1,
          stop: ["\n\n\n"]
        },
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const delta = obj?.message?.content || obj?.response || '';
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          // ignore malformed fragments
        }
      }
    }
    // flush remainder
    if (buffer.trim()) {
      try {
        const obj = JSON.parse(buffer.trim());
        const delta = obj?.message?.content || obj?.response || '';
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {}
    }
    return full;
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
        // Try to load a cached summary nearest to the provided selection/text
        const provided = (msg?.text ?? '') as string;
        let context = trimChars(provided, 1500);
        try {
          const docId = await getDocId();
          const summaries = await loadSummaries(docId);
          const best = pickBestSummary(provided, summaries);
          if (best?.text) {
            context = trimChars(best.text + (provided ? ('\n\nSelection:\n' + provided) : ''), 1500);
          }
        } catch {}
        const question = (msg?.question ?? '').trim();
        console.log('QA Request:', { context: context.substring(0, 100), question });
        try {
          // Get active tab for streaming updates
          const tab = await getActiveOverleafTab();
          // Use streaming for better UX
          let streamedOutput = '';
          await ollamaChatStream({
            system: SYSTEM_PROMPT,
            user: QA_PROMPT(context, question),
            numPredict: 180,
            numCtx: 2048,
            onDelta: (delta: string) => {
              streamedOutput += delta;
              // Send delta to content script for real-time display
              if (tab?.id) {
                chrome.tabs.sendMessage(tab.id, { cmd: 'qa:answer:delta', text: delta }).catch(() => {});
              }
            },
          });
          
          // Ensure LaTeX completeness before sending final response
          const finalOutput = ensureLatexCompleteness(streamedOutput);
          console.log('QA Answer:', finalOutput);
          sendResponse({ ok: true, text: finalOutput });
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
            numPredict: 200,
            numCtx: 2048,
          });
          const safeOut = (out && out.trim()) ? out : 'No substantial issues detected. Keep going!';
          const completed = ensureCompleteSentences(safeOut);
          const finalOut = ensureLatexCompleteness(completed);
          sendResponse({ ok: true, text: finalOut, updatedAt: Date.now() });
        } catch (e: any) {
          sendResponse({ ok: false, error: e?.message || 'Model error' });
        }
        return;
      }
      if (msg?.cmd === 'coach:expand') {
        const snippet = trimChars(msg?.text ?? '', 1500);
        try {
          const out = await ollamaChat({
            system: SYSTEM_PROMPT,
            user: COACH_PROMPT_EXPAND(snippet),
            numPredict: 350,
            numCtx: 2048,
          });
          const safeOut = (out && out.trim()) ? out : 'No substantial issues detected. Keep going!';
          const completed = ensureCompleteSentences(safeOut);
          const finalOut = ensureLatexCompleteness(completed);
          sendResponse({ ok: true, text: finalOut, updatedAt: Date.now() });
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
        // Fire-and-forget summary cache update
        maybeUpdateSummary(sample.text).catch(() => {});
        try {
          await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: 'Thinking…' }).catch(() => {});
          console.log('Coach: Sending request with text length:', sample.text.length);
          
          // Use streaming for better UX
          let streamedOutput = '';
          await ollamaChatStream({
            system: SYSTEM_PROMPT,
            user: COACH_PROMPT(trimChars(sample.text, 1500)),
            numPredict: 200,
            numCtx: 2048,
            onDelta: (delta: string) => {
              streamedOutput += delta;
              if (tab.id) {
                chrome.tabs.sendMessage(tab.id, { cmd: 'coach:answer:delta', text: delta }).catch(() => {});
              }
            },
          });
          
          console.log('Coach: Final output:', streamedOutput);
          const safeOut = (streamedOutput && streamedOutput.trim()) ? streamedOutput : 'No substantial issues detected. Keep going!';
          const completed = ensureCompleteSentences(safeOut);
          const finalOut = ensureLatexCompleteness(completed);
          await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:answer', text: finalOut, updatedAt: Date.now() });
          sendResponse({ ok: true });
        } catch (e: any) {
          console.error('Coach: Error:', e);
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
    // Fire-and-forget summary cache update
    maybeUpdateSummary(sample.text).catch(() => {});
    try {
      await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: 'Thinking…' }).catch(() => {});
      const out = await ollamaChat({
        system: SYSTEM_PROMPT,
        user: COACH_PROMPT(trimChars(sample.text, 1500)),
        numPredict: 200,
        numCtx: 2048,
      });
      const safeOut = (out && out.trim()) ? out : 'No substantial issues detected. Keep going!';
      const completed = ensureCompleteSentences(safeOut);
      const finalOut = ensureLatexCompleteness(completed);
      await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:answer', text: finalOut, updatedAt: Date.now() });
    } catch {
      // silently ignore on tick, but try to inform UI
      await chrome.tabs.sendMessage(tab.id, { cmd: 'coach:status', text: '(error) Model unavailable' }).catch(() => {});
    }
  });