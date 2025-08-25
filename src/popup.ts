// logic for popup (pause/resume, run now)

// WriteTank — Popup: quick controls & settings

type Settings = {
    endpoint: string;
    model: string;
    intervalMin: number;
    paused: boolean;
  };
  
  function qs<T extends HTMLElement>(sel: string) { return document.querySelector(sel) as T; }
  
  async function getSettings(): Promise<Settings> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ cmd: 'settings:get' }, (s) => resolve(s));
    });
  }
  async function setSettings(patch: Partial<Settings>) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ cmd: 'settings:set', patch }, () => resolve(null));
    });
  }
  
  async function init() {
    const s = await getSettings();
    (qs<HTMLInputElement>('#paused')).checked = !!s.paused;
    (qs<HTMLInputElement>('#interval')).value = String(s.intervalMin);
    (qs<HTMLInputElement>('#model')).value = s.model;
    (qs<HTMLInputElement>('#endpoint')).value = s.endpoint;
  
    qs<HTMLInputElement>('#paused').addEventListener('change', async (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      await setSettings({ paused: checked });
    });
  
    qs<HTMLButtonElement>('#run').addEventListener('click', () => {
      chrome.runtime.sendMessage({ cmd: 'run-now' });
    });
  
    qs<HTMLButtonElement>('#save').addEventListener('click', async () => {
      const intervalMin = Math.max(1, Math.min(60, parseInt((qs<HTMLInputElement>('#interval')).value || '5', 10)));
      const model = (qs<HTMLInputElement>('#model')).value.trim() || 'gpt-oss:20b';
      const endpoint = (qs<HTMLInputElement>('#endpoint')).value.trim() || 'http://localhost:11434';
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
  
  function setStatus(text: string, cls?: 'ok'|'bad') {
    const el = qs<HTMLSpanElement>('#status');
    el.textContent = text;
    el.className = cls ? cls : 'muted';
  }
  
  init();