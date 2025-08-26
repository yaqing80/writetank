// injects panels into Overleaf page

// WriteTank — Content Script
// - Injects combined Q&A and Auto-coach panel
// - Grabs selection or editor text from Overleaf
// - Sends requests to background and renders answers

let writeTankPanel: HTMLElement | null = null;

function injectPanels() {
  if (!writeTankPanel) {
    writeTankPanel = document.createElement('div');
    writeTankPanel.id = 'wt-panel';
    writeTankPanel.innerHTML = `
      <div class="wt-hdr">
        <span>WriteTank</span>
        <div class="wt-tabs">
          <button class="wt-tab active" data-tab="qa">Q&A</button>
          <button class="wt-tab" data-tab="coach">Coach</button>
        </div>
      </div>
      
      <div class="wt-content" id="wt-qa-content">
        <textarea id="wt-q" rows="2" placeholder="Ask a question…"></textarea>
        <div class="wt-row">
          <label class="wt-chk"><input type="checkbox" id="wt-useSel" checked> Use selection</label>
          <button id="wt-ask">Ask</button>
        </div>
        <pre id="wt-a" class="wt-out" aria-live="polite"></pre>
        <div class="wt-row">
          <button id="wt-copy">Copy</button>
        </div>
      </div>
      
      <div class="wt-content" id="wt-coach-content" style="display: none;">
        <pre id="wt-coach-out" class="wt-out" aria-live="polite">(no suggestions yet)</pre>
        <div class="wt-row">
          <button id="wt-run">Run now</button>
          <button id="wt-pause">Pause</button>
          <span id="wt-time" class="wt-sub"></span>
        </div>
      </div>
    `;
    document.documentElement.appendChild(writeTankPanel);

    // Wire up event handlers
    writeTankPanel.querySelector<HTMLButtonElement>('#wt-ask')!.onclick = onAsk;
    writeTankPanel.querySelector<HTMLButtonElement>('#wt-copy')!.onclick = () => copyText((writeTankPanel!.querySelector('#wt-a') as HTMLElement).textContent || '');
    writeTankPanel.querySelector<HTMLButtonElement>('#wt-run')!.onclick = () => chrome.runtime.sendMessage({ cmd: 'run-now' });
    writeTankPanel.querySelector<HTMLButtonElement>('#wt-pause')!.onclick = togglePause;
    
    // Tab switching
    writeTankPanel.querySelectorAll('.wt-tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.getAttribute('data-tab')!));
    });
    
    makeDraggable(writeTankPanel, '.wt-hdr');
    refreshPauseLabel();
  }
}

function switchTab(tabName: string) {
  // Update tab buttons
  writeTankPanel!.querySelectorAll('.wt-tab').forEach(tab => {
    tab.classList.toggle('active', tab.getAttribute('data-tab') === tabName);
  });
  
  // Show/hide content
  writeTankPanel!.querySelectorAll('.wt-content').forEach(content => {
    (content as HTMLElement).style.display = 'none';
  });
  (writeTankPanel!.querySelector(`#wt-${tabName}-content`) as HTMLElement)!.style.display = 'block';
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
  const qEl = writeTankPanel!.querySelector<HTMLTextAreaElement>('#wt-q')!;
  const useSel = writeTankPanel!.querySelector<HTMLInputElement>('#wt-useSel')!.checked;
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
  (writeTankPanel!.querySelector('#wt-a') as HTMLElement).textContent = text;
}

function renderCoach(text: string, ts?: number) {
  (writeTankPanel!.querySelector('#wt-coach-out') as HTMLElement).textContent = text || '(no suggestions)';
  if (ts) (writeTankPanel!.querySelector('#wt-time') as HTMLElement).textContent = `Updated ${new Date(ts).toLocaleTimeString()}`;
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
  const b = writeTankPanel!.querySelector<HTMLButtonElement>('#wt-pause')!;
  b.textContent = s?.paused ? 'Resume' : 'Pause';
}
async function togglePause() {
  const s = await chrome.runtime.sendMessage({ cmd: 'settings:get' });
  await chrome.runtime.sendMessage({ cmd: 'settings:set', patch: { paused: !s?.paused } });
  refreshPauseLabel();
}

// Boot
injectPanels();