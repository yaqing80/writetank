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
          <label class="wt-chk"><input type="checkbox" id="wt-useVisible"> Use visible area</label>
          <span id="wt-sel-status" class="wt-sub" style="font-size: 10px;">✓</span>
          <button id="wt-ask">Ask</button>
        </div>
        <div class="wt-preview" id="wt-preview" style="display: block;">
          <div class="wt-preview-header">Content being used:</div>
          <div class="wt-preview-content" id="wt-preview-text"></div>
        </div>
        <pre id="wt-a" class="wt-out" aria-live="polite">(no answer yet)</pre>
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
    writeTankPanel.querySelector<HTMLButtonElement>('#wt-run')!.onclick = runCoachNow;
    writeTankPanel.querySelector<HTMLButtonElement>('#wt-pause')!.onclick = togglePause;
    
    // Tab switching
    writeTankPanel.querySelectorAll('.wt-tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.getAttribute('data-tab')!));
    });
    
    // Add selection change listener for real-time preview updates
    document.addEventListener('selectionchange', updatePreviewOnSelectionChange);
    
    // Add checkbox change listeners (mutually exclusive)
    const selCb = writeTankPanel.querySelector<HTMLInputElement>('#wt-useSel')!;
    const visCb = writeTankPanel.querySelector<HTMLInputElement>('#wt-useVisible')!;
    selCb.addEventListener('change', () => {
      if (selCb.checked) visCb.checked = false;
      updatePreviewOnSelectionChange();
    });
    visCb.addEventListener('change', () => {
      if (visCb.checked) selCb.checked = false;
      updatePreviewOnSelectionChange();
    });
    
    makeDraggable(writeTankPanel, '.wt-hdr');
    refreshPauseLabel();
    
    // Initial preview update
    setTimeout(() => updatePreviewOnSelectionChange(), 100);
  }
}

function updatePreviewOnSelectionChange() {
  if (!writeTankPanel) return;
  
  const useSel = writeTankPanel.querySelector<HTMLInputElement>('#wt-useSel')!.checked;
  const useVisible = writeTankPanel.querySelector<HTMLInputElement>('#wt-useVisible')!.checked;
  const statusEl = writeTankPanel.querySelector('#wt-sel-status') as HTMLElement;
  
  if (useSel) {
    const sample = grabEditorText(true);
    showPreview(sample, true);
    
    // Update selection status
    if (sample.selection.length > 0) {
      statusEl.textContent = '✓';
      statusEl.style.color = '#4ade80';
    } else {
      statusEl.textContent = '○';
      statusEl.style.color = '#fbbf24';
    }
  } else if (useVisible) {
    const sample = grabEditorText(false, 'visible');
    showPreview(sample, false);
    statusEl.textContent = '—';
    statusEl.style.color = '#6b7280';
  } else {
    statusEl.textContent = '—';
    statusEl.style.color = '#6b7280';
    // Show empty preview state
    const previewEl = writeTankPanel!.querySelector('#wt-preview') as HTMLElement;
    const previewTextEl = writeTankPanel!.querySelector('#wt-preview-text') as HTMLElement;
    const previewHeaderEl = writeTankPanel!.querySelector('.wt-preview-header') as HTMLElement;
    previewEl.style.display = 'block';
    previewHeaderEl.textContent = 'No context:';
    previewTextEl.textContent = '(your question will be answered without using page text)';
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
  const useVisible = writeTankPanel!.querySelector<HTMLInputElement>('#wt-useVisible')!.checked;
  const question = (qEl.value || '').trim();
  if (!question) {
    renderQA('(enter a question)'); return;
  }
  let sample = { selection: '', text: '', wasTruncated: false } as { selection: string; text: string; wasTruncated: boolean };
  if (useSel) {
    sample = grabEditorText(true);
    if (!sample.selection) {
      renderQA('(no selection)');
      showPreview(sample, true);
      return;
    }
  } else if (useVisible) {
    sample = grabEditorText(false, 'visible');
  } else {
    // No context
    sample = { selection: '', text: '', wasTruncated: false };
  }
  
  // Show preview of what text is being used
  showPreview(sample, useSel);
  
  // Debug info - show what text is being used
  const debugInfo = `=== WRITETANK DEBUG ===
Using: ${useSel ? 'SELECTION' : 'FULL DOCUMENT'}
Selection available: ${sample.selection.length > 0 ? 'YES' : 'NO'}
Text length: ${sample.text.length} chars
Text truncated: ${sample.wasTruncated ? 'YES' : 'NO'}
Selected text: "${sample.selection}"
Text preview: "${sample.text.substring(0, 100)}${sample.text.length > 100 ? '...' : ''}"
=====================`;
  console.log(debugInfo);
  
  renderQA('Thinking…');
  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'qa', question, text: sample.text });
    console.log('QA Response:', res);
    if (res?.ok) {
      renderQA(res.text || '(no answer)');
    } else {
      renderQA(`(error) ${res?.error || 'Model unavailable'}`);
    }
  } catch (error) {
    console.error('QA Error:', error);
    renderQA(`(error) ${error}`);
  }
}

async function runCoachNow() {
  const runBtn = writeTankPanel!.querySelector<HTMLButtonElement>('#wt-run')!;
  const timeEl = writeTankPanel!.querySelector('#wt-time') as HTMLElement;
  try {
    runBtn.disabled = true;
    timeEl.textContent = 'Running…';
    const res = await chrome.runtime.sendMessage({ cmd: 'run-now' });
    if (res?.ok) {
      // renderCoach will update time on message receipt; put a temporary status
      timeEl.textContent = 'Completed';
    } else {
      timeEl.textContent = `(error) ${res?.error || 'Run failed'}`;
    }
  } catch (e: any) {
    timeEl.textContent = `(error) ${e?.message || e}`;
  } finally {
    runBtn.disabled = false;
  }
}

function showPreview(sample: { selection: string; text: string; wasTruncated: boolean }, useSel: boolean) {
  const previewEl = writeTankPanel!.querySelector('#wt-preview') as HTMLElement;
  const previewTextEl = writeTankPanel!.querySelector('#wt-preview-text') as HTMLElement;
  const previewHeaderEl = writeTankPanel!.querySelector('.wt-preview-header') as HTMLElement;
  
  console.log('Preview Debug:', {
    useSel,
    selectionLength: sample.selection.length,
    textLength: sample.text.length,
    previewEl: !!previewEl,
    previewTextEl: !!previewTextEl
  });
  
  if (useSel && sample.selection.length > 0) {
    console.log('Showing selection preview:', sample.selection);
    previewEl.style.display = 'block';
    previewHeaderEl.textContent = sample.wasTruncated ? 'Selected text (trimmed to 1500 chars):' : 'Selected text:';
    previewTextEl.textContent = sample.selection;
    // Truncation already reflected in header when applicable
  } else if (!useSel) {
    console.log('Showing full document preview');
    previewEl.style.display = 'block';
    previewHeaderEl.textContent = sample.wasTruncated ? 'Full document (trimmed to 1500 chars):' : 'Full document:';
    previewTextEl.textContent = sample.text.length > 200 ? 
      sample.text.substring(0, 200) + '...' : 
      sample.text;
    // Truncation already reflected in header when applicable
  } else {
    // Selection mode with no selection
    previewEl.style.display = 'block';
    previewHeaderEl.textContent = 'Selected text:';
    previewTextEl.textContent = '(no text selected)';
  }
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
function grabEditorText(preferSelection = true, mode: 'all' | 'visible' = 'all'): { selection: string; text: string; wasTruncated: boolean } {
  // Try multiple methods to get selection
  let sel = '';
  
  // Method 1: Standard window.getSelection()
  const windowSel = window.getSelection();
  if (windowSel && windowSel.toString().trim()) {
    sel = windowSel.toString().trim();
    console.log('Got selection via window.getSelection():', `"${sel}"`);
  }
  
  // Method 2: Try CodeMirror selection if available
  if (!sel) {
    const cmEditor = (window as any).cm?.editor || 
                    (document.querySelector('.cm-editor') as any)?.cm ||
                    document.querySelector('[data-lexical-editor]');
    
    if (cmEditor && cmEditor.getSelection) {
      try {
        const cmSel = cmEditor.getSelection();
        if (cmSel && cmSel.trim()) {
          sel = cmSel.trim();
          console.log('Got selection via CodeMirror:', `"${sel}"`);
        }
      } catch (e) {
        console.log('CodeMirror selection failed:', e);
      }
    }
  }
  
  // Method 2.5: Try CodeMirror via different selectors (for newer versions)
  if (!sel) {
    const cmElements = document.querySelectorAll('.cm-editor, .cm-content, [data-lexical-editor]');
    for (const element of cmElements) {
      try {
        const cm = (element as any).cm;
        if (cm && cm.getSelection) {
          const cmSel = cm.getSelection();
          if (cmSel && cmSel.trim()) {
            sel = cmSel.trim();
            console.log('Got selection via CodeMirror (alt):', `"${sel}"`);
            break;
          }
        }
      } catch (e) {
        // Continue to next element
      }
    }
  }
  
  // Method 3: Try Ace editor selection
  if (!sel) {
    const aceEditor = (window as any).ace?.edit;
    if (aceEditor && aceEditor.getSelectedText) {
      try {
        const aceSel = aceEditor.getSelectedText();
        if (aceSel && aceSel.trim()) {
          sel = aceSel.trim();
          console.log('Got selection via Ace editor:', `"${sel}"`);
        }
      } catch (e) {
        console.log('Ace selection failed:', e);
      }
    }
  }
  
  // Method 4: Try contenteditable elements
  if (!sel) {
    const contentEditableElements = document.querySelectorAll('[contenteditable="true"]');
    for (const element of contentEditableElements) {
      try {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          if (element.contains(range.commonAncestorContainer)) {
            const selectedText = range.toString().trim();
            if (selectedText) {
              sel = selectedText;
              console.log('Got selection via contenteditable:', `"${sel}"`);
              break;
            }
          }
        }
      } catch (e) {
        // Continue to next element
      }
    }
  }
  
  let text = '';
  
  console.log('=== TEXT GRAB DEBUG ===');
  console.log('Final selection:', `"${sel}"`);
  console.log('Selection length:', sel.length);
  console.log('Prefer selection:', preferSelection);
  
  if (preferSelection) {
    if (sel.length > 0) {
      text = sel;
      console.log('Using selection as text');
    } else {
      // Stay empty; do NOT fallback to full document when selection mode is chosen
      text = '';
      console.log('Selection mode chosen but no selection; not falling back to full document');
    }
  } else {
    console.log('Looking for editor content...');
    
    // Method 1: CodeMirror content
    const cm = document.querySelector('.cm-content, .cm-editor');
    if (cm) {
      console.log('Found CodeMirror editor');
      if (mode === 'visible') {
        const scroller = document.querySelector('.cm-scroller') as HTMLElement | null;
        const content = document.querySelector('.cm-content') as HTMLElement | null;
        if (scroller && content) {
          const top = scroller.scrollTop;
          const bottom = top + scroller.clientHeight;
          const allLines = Array.from(content.querySelectorAll('.cm-line, .cm-lineWrapping, .cm-lineContent')) as HTMLElement[];
          const visible = allLines.filter(l => {
            const y = l.offsetTop;
            const h = l.offsetHeight || 18;
            return y + h >= top && y <= bottom;
          });
          const pad = 16;
          let firstIdx = 0, lastIdx = -1;
          if (visible.length > 0) {
            // padding only below: do not extend above the first visible line
            firstIdx = allLines.indexOf(visible[0]);
            lastIdx = Math.min(allLines.length - 1, allLines.indexOf(visible[visible.length - 1]) + pad);
          }
          const slice = lastIdx >= firstIdx ? allLines.slice(firstIdx, lastIdx + 1) : visible;
          text = (slice.length > 0 ? slice : allLines).map(n => n.innerText).join('\n');
          if (!text.trim() && allLines.length > 0) {
            // Fallback: take the next ~20 lines from the top of viewport
            const start = firstIdx >= 0 ? firstIdx : 0;
            const end = Math.min(allLines.length, start + 20);
            text = allLines.slice(start, end).map(n => n.innerText).join('\n');
          }
        } else {
          const lines = Array.from(cm.querySelectorAll('.cm-line, .cm-lineWrapping, .cm-lineContent')).map(n => (n as HTMLElement).innerText);
          text = lines.join('\n');
        }
      } else {
        const lines = Array.from(cm.querySelectorAll('.cm-line, .cm-lineWrapping, .cm-lineContent')).map(n => (n as HTMLElement).innerText);
        text = lines.join('\n');
      }
      console.log('CodeMirror text length:', text.length);
    } else {
      // Method 2: Ace editor content
      const ace = document.querySelector('.ace_content');
      if (ace) {
        console.log('Found Ace editor');
        if (mode === 'visible') {
          try {
            const editor = (window as any).ace?.edit?.(document.querySelector('.ace_editor'));
            if (editor) {
              const first = editor.getFirstVisibleRow();
              const last = editor.getLastVisibleRow();
              const extra = 8;
              const Range = (window as any).ace.require('ace/range').Range;
              // padding only below: start from first, extend only downward
              const range = new Range(first, 0, last + extra, 0);
              text = editor.session.getTextRange(range);
              if (!text || !text.trim()) {
                // Fallback to a small window after the first visible row
                const range2 = new Range(first, 0, Math.min(last + 12, first + 24), 0);
                text = editor.session.getTextRange(range2);
              }
            }
          } catch {}
        }
        if (!text) {
          const lines = Array.from(ace.querySelectorAll('.ace_line')).map(n => (n as HTMLElement).innerText);
          text = lines.join('\n');
        }
        console.log('Ace text length:', text.length);
      } else {
        // Method 3: Try to get content from any editor-like element
        const editorElements = document.querySelectorAll('[contenteditable="true"], .editor, .monaco-editor');
        if (editorElements.length > 0) {
          console.log('Found contenteditable/editor elements');
          text = Array.from(editorElements).map(el => (el as HTMLElement).innerText).join('\n');
        } else {
          console.log('Using document.body.innerText');
          text = document.body.innerText || '';
        }
      }
    }
  }
  
  // Clean up the text
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  
  // Trim to match background script limits (1500 chars)
  const max = 1500;
  const wasTruncated = text.length > max;
  if (wasTruncated) {
    text = text.slice(0, max);
  }
  
  console.log('Final text length:', text.length);
  console.log('Final text preview:', `"${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
  console.log('Text was truncated:', wasTruncated);
  console.log('========================');
  
  return { selection: sel, text, wasTruncated };
}

// Listen for background messages (coach results, etc.)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === 'coach:answer') {
    renderCoach(msg.text, msg.updatedAt);
  }
  if (msg?.cmd === 'coach:status') {
    const timeEl = writeTankPanel!.querySelector('#wt-time') as HTMLElement;
    if (timeEl) timeEl.textContent = msg.text || '';
  }
  return undefined;
});

// Respond to background asking for current text
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.cmd === 'grabText') {
    const mode = msg?.mode === 'visible' ? 'visible' : 'all';
    const sample = grabEditorText(false, mode);
    // Send only the text to maintain compatibility with background script
    sendResponse({ text: sample.text });
    return true;
  }
});

// Pause/Resume helpers
async function refreshPauseLabel() {
  const s = await chrome.runtime.sendMessage({ cmd: 'settings:get' });
  const b = writeTankPanel!.querySelector<HTMLButtonElement>('#wt-pause')!;
  b.textContent = s?.paused ? 'Resume' : 'Pause';
  const timeEl = writeTankPanel!.querySelector('#wt-time') as HTMLElement;
  timeEl.textContent = s?.paused ? 'Auto-coach: Paused' : 'Auto-coach: On';
}
async function togglePause() {
  const s = await chrome.runtime.sendMessage({ cmd: 'settings:get' });
  await chrome.runtime.sendMessage({ cmd: 'settings:set', patch: { paused: !s?.paused } });
  refreshPauseLabel();
}

// Boot
injectPanels();