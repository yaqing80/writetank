# WriteTank — Academic Writing Assistant for LaTex

**WriteTank is a privacy-first academic writing assistant that helps researchers and students structure, improve, and polish their writing — directly inside Overleaf.**  
It runs **100% locally** on your machine with [Ollama](https://ollama.ai), ensuring that your thesis, papers, and personal documents remain private.  

---

## Features

- **Two Smart Modes**  
  - **Q&A Panel** → Ask direct questions about your draft and receive concise answers in **LaTeX format**.  
  - **Auto-Coach Panel** → Every few minutes (or on demand), WriteTank suggests a structure, concrete details to add, and a polished paragraph rewrite.  

- **LaTeX-Native Output** → Results are copy-paste ready for Overleaf.  
- **Privacy by Design** → Powered by local LLMs (**gpt-oss:20b** is chosen here).  
- **Modern UX** → Draggable panels, dark theme, Copy button, Pause/Resume, live status.  

---

## Tech Stack

- **Chrome Extension (Manifest V3)** built with **Vite + TypeScript**  
- **Local Model Runtime**: [Ollama](https://ollama.ai)  
- **Model**: `gpt-oss:20b`, suitable for personal computer
- **Engineering highlights**:  
  - Context-aware text extraction from Overleaf editor  
  - Prompt engineering for LaTeX-structured output  
  - Background service worker → Ollama API → content script loop  

---

## Installation

### 1. Install Ollama
Download and install [Ollama](https://ollama.ai/download).  

### 2. Pull a model
```bash
# Hackathon model
ollama pull gpt-oss:20b
```

### 3. Clone and build WriteTank

Clone the repository and install dependencies:
```bash
git clone https://github.com/yaqing80/writetank.git
cd writetank
npm install
npm run build
```

### 4. Load the extension in Chrome
	
1.	Open chrome://extensions in Google Chrome
2.	Enable Developer mode (toggle in top right)
3.	Click Load unpacked
4.	Select the dist/ folder

You should now see WriteTank in your Chrome extensions bar. This is an easy and simple integration with Overleaf for online LaTex editor support.

### 5. Open Overleaf

1.	Go to Overleaf and open any project
2.	WriteTank will inject two panels:
-	**Q&A Panel** (bottom-right)
-	**Auto-Coach** Panel (next to it)

 **Your locally downloaded gpt-oss:20b model should be working as an API smoothly for this browser extension, particularly designed for academic writing support using LaTeX.**
