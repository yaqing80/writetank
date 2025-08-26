// WriteTank — Popup: quick controls & settings

type Settings = {
    endpoint: string;
    model: string;
    intervalMin: number;
    paused: boolean;
  };
  
  function qs<T extends HTMLElement>(sel: string) {
    const el = document.querySelector(sel) as T | null;
    if (!el) throw new Error(`Missing element: ${sel}`);
    return el;
  }
  
  function normalizeEndpoint(v: string) {
    const s = (v || '').trim() || 'http://localhost:11434';
    return s.replace(/\/+$/, ''); // remove trailing slashes
  }
  
  function setStatus(text: string, cls?: 'ok' | 'bad') {
    const el = document.querySelector('#status') as HTMLSpanElement | null;
    if (!el) return;
    el.textContent = text;
    el.className = `status-indicator ${cls || 'muted'}`;
    if (cls) setTimeout(() => setStatus('Idle'), 1200);
  }
  
  async function getSettings(): Promise<Settings> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ cmd: 'settings:get' }, (s: Settings) => resolve(s));
    });
  }
  
  async function setSettings(patch: Partial<Settings>) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ cmd: 'settings:set', patch }, () => resolve(null));
    });
  }
  
  function wireEvents() {
    const pausedEl = qs<HTMLInputElement>('#paused');
    const intervalEl = qs<HTMLInputElement>('#interval');
    const modelEl = qs<HTMLInputElement>('#model');
    const endpointEl = qs<HTMLInputElement>('#endpoint');
  
    pausedEl.addEventListener('change', async (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      await setSettings({ paused: checked });
      setStatus(checked ? 'Paused' : 'Resumed');
    });
  
    qs<HTMLButtonElement>('#run').addEventListener('click', () => {
      setStatus('Running…');
      chrome.runtime.sendMessage({ cmd: 'run-now' }, (res) => {
        if (res?.ok) setStatus('Done', 'ok');
        else setStatus(res?.error || 'Error', 'bad');
      });
    });
  
    qs<HTMLButtonElement>('#save').addEventListener('click', async () => {
      const intervalMinRaw = parseInt(intervalEl.value || '5', 10);
      const intervalMin = Math.max(1, Math.min(60, Number.isFinite(intervalMinRaw) ? intervalMinRaw : 5));
      const model = (modelEl.value || '').trim() || 'gpt-oss:20b';
      const endpoint = normalizeEndpoint(endpointEl.value);
  
      await setSettings({ intervalMin, model, endpoint });
      setStatus('Saved', 'ok');
    });
  
    qs<HTMLButtonElement>('#test').addEventListener('click', async () => {
      setStatus('Testing…');
      chrome.runtime.sendMessage({ cmd: 'ping-endpoint' }, (res) => {
        setStatus(res?.ok ? 'OK' : 'Offline', res?.ok ? 'ok' : 'bad');
      });
    });
  }
  
  async function init() {
    // load settings (with safe defaults)
    const s = await getSettings();
    qs<HTMLInputElement>('#paused').checked = !!s?.paused;
    qs<HTMLInputElement>('#interval').value = String(s?.intervalMin ?? 5);
    qs<HTMLInputElement>('#model').value = s?.model ?? 'gpt-oss:20b';
    qs<HTMLInputElement>('#endpoint').value = s?.endpoint ?? 'http://localhost:11434';
  }
  
  document.addEventListener('DOMContentLoaded', () => {
    try {
      wireEvents();
      init().catch(() => setStatus('Load failed', 'bad'));
    } catch {
      // If a selector is missing, show a hint
      setStatus('Popup init error', 'bad');
    }
  });