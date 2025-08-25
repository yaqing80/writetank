// injects panels into Overleaf page

// WriteTank — Content Script
// - Injects Q&A and Auto-coach panels
// - Grabs selection or editor text from Overleaf
// - Sends requests to background and renders answers

let qaPanel: HTMLElement | null = null;
let coachPanel: HTMLElement | null = null;

function injectPanels() {
  if (!qaPanel) {
    qaPanel = document.createElement('div');
    qaPanel.id = 'wt-qa';
    qaPanel.innerHTML = `
      <div class="wt-hdr">
        <span>WriteTank — Q&A</span>
      </div>
      <textarea id="wt-q" rows="3" placeholder="Ask a question…"></textarea>
      <div class="wt-row">
        <label class="wt-chk"><input type="checkbox" id="wt-useSel" checked> Use selection</label>
        <button id="wt-ask">Ask</button>
      </div>
      <pre id="wt-a" class="wt-out" aria-live="polite"></pre>
      <div class="wt-row">
        <button id="wt-copy">Copy</button>
      </div>
    `;
    document.documentElement.appendChild(qaPanel);

    qaPanel.querySelector<HTMLButtonElement>('#wt-ask')!.onclick = onAsk;
    qaPanel.querySelector<HTMLButtonElement>('#wt-copy')!.onclick = () => copyText((qaPanel!.querySelector('#wt-a') as HTMLElement).textContent || '');
    makeDraggable(qaPanel, '.wt-hdr');
  }

  if (!coachPanel) {
    coachPanel = document.createElement('div');
    coachPanel.id = 'wt-coach';
    coachPanel.innerHTML = `
      <div class="wt-hdr">
        <span>WriteTank — Coach</span>
        <span id="wt-time" class="wt-sub"></span>
      </div>
      <pre id="wt-coach-out" class="wt-out" aria-live="polite">(no suggestions yet)</pre>
      <div class="wt-row">
        <button id="wt-run">Run now</button>
        <button id="wt-pause">Pause</button>
      </div>
    `;
    document.documentElement.appendChild(coachPanel);

    coachPanel.querySelector<HTMLButtonElement>('#wt-run')!.onclick = () => chrome.runtime.sendMessage({ cmd: 'run-now' });
    coachPanel.querySelector<HTMLButtonElement>('#wt-pause')!.onclick = togglePause;
    makeDraggable(coachPanel, '.wt-hdr');
    refreshPauseLabel();
  }
}

function makeDraggable(el: HTMLElement, handleSel: string) {
  const handle = el.querySelector(handleSel) as HTMLElement;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  handle.addEventListener('mousedown', (e) => {
    dragging = true; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    el.style.left = `${Math.max(8, ox + (e.clientX - sx))}px`;
    el.style.top = `${Math.max(8, oy + (e.clientY - sy))}px`;
    el.style.right = 'auto'; el.style.bottom = 'auto';
  });
}

async function onAsk() {
  const qEl = qaPanel!.querySelector<HTMLTextAreaElement>('#wt-q')!;
  const useSel = qaPanel!.querySelector<HTMLInputElement>('#wt-useSel')!.checked;
  const question = (qEl.value || '').trim();
  if (!question) {
    renderQA('(enter a question)'); return;
  }
  const sample = grabEditorText(useSel);
  renderQA('Thinking…');
  const res = await chrome.runtime.sendMessage({ cmd: 'qa', question, text: sample.text });
  if (res?.ok) renderQA(res.text || '(no answer)'); else renderQA(`(error) ${res?.error || 'Model unavailable'}`);
}

function renderQA(text: string) {
  (qaPanel!.querySelector('#wt-a') as HTMLElement).textContent = text;
}

function renderCoach(text: string, ts?: number) {
  (coachPanel!.querySelector('#wt-coach-out') as HTMLElement).textContent = text || '(no suggestions)';
  if (ts) (coachPanel!.querySelector('#wt-time') as HTMLElement).textContent = `Updated ${new Date(ts).toLocaleTimeString()}`;
}

function copyText(t: string) {
  navigator.clipboard.writeText(t).then(() => toast('Copied'));
}

function toast(msg: string) {
  const t = document.createElement('div');
  t.className = 'wt-toast';
  t.textContent = msg;
  document.documentElement.appendChild(t);
  setTimeout(() => t.remove(), 1200);
}

// Grab selection or Overleaf editor text (CodeMirror or Ace), trimmed
function grabEditorText(preferSelection = true): { selection: string; text: string } {
  const sel = window.getSelection()?.toString()?.trim() || '';
  let text = '';
  if (preferSelection && sel.length > 0) {
    text = sel;
  } else {
    const cm = document.querySelector('.cm-content');
    const ace = document.querySelector('.ace_content');
    if (cm) {
      const lines = Array.from(cm.querySelectorAll('.cm-line, .cm-lineWrapping')).map(n => (n as HTMLElement).innerText);
      text = lines.join('\n');
    } else if (ace) {
      const lines = Array.from(ace.querySelectorAll('.ace_line')).map(n => (n as HTMLElement).innerText);
      text = lines.join('\n');
    } else {
      text = document.body.innerText || '';
    }
  }
  // Trim to a few thousand chars to keep latency under control
  const max = 4000;
  if (text.length > max) {
    // take a window around selection if present, else the start
    text = text.slice(0, max);
  }
  return { selection: sel, text };
}

// Listen for background messages (coach results, etc.)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === 'coach:answer') {
    renderCoach(msg.text, msg.updatedAt);
  }
  return undefined;
});

// Respond to background asking for current text
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.cmd === 'grabText') {
    const sample = grabEditorText(false);
    sendResponse(sample);
    return true;
  }
});

// Pause/Resume helpers
async function refreshPauseLabel() {
  const s = await chrome.runtime.sendMessage({ cmd: 'settings:get' });
  const b = coachPanel!.querySelector<HTMLButtonElement>('#wt-pause')!;
  b.textContent = s?.paused ? 'Resume' : 'Pause';
}
async function togglePause() {
  const s = await chrome.runtime.sendMessage({ cmd: 'settings:get' });
  await chrome.runtime.sendMessage({ cmd: 'settings:set', patch: { paused: !s?.paused } });
  refreshPauseLabel();
}

// Boot
injectPanels();