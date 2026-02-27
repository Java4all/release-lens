# ReleaseLens — Technical Documentation

> AI-powered vendor release documentation analysis platform  
> Version 1.4 · [github.com/Java4all/release-lens](https://github.com/Java4all/release-lens)

---

## Overview

ReleaseLens is a **fully client-side single-page application** — there is no backend server. All AI inference, PDF parsing, and Word document generation happen directly in the user's browser. The Docker container exists solely to serve the built static files via Nginx.

---

## Technology Stack

### Frontend Framework

| Technology | Version | Purpose |
|---|---|---|
| **React** | 18 | UI component model, state management |
| **JSX** | — | HTML-in-JS syntax, transpiled at build time |

All UI is built with React functional components and hooks (`useState`, `useRef`). No class components, no Redux — state is local to the single root component.

### Build & Tooling

| Technology | Purpose |
|---|---|
| **Vite** | Dev server and production build tool |
| **esbuild** | Ultra-fast JS/JSX transpiler (used internally by Vite) |
| **Node.js** | Build-time runtime for the toolchain |

### Styling

No CSS framework is used. All styles are written as **inline React style objects** (`style={{ ... }}`), keeping everything co-located with the components.

Typography is loaded from **Google Fonts** via CDN:
- `Syne` — headings and logo wordmark
- `DM Sans` — body text
- `JetBrains Mono` — monospace labels, badges, code

### AI & API

| Technology | Details |
|---|---|
| **Anthropic Claude API** | `POST https://api.anthropic.com/v1/messages` |
| **Model** | `claude-haiku-4-5-20251001` |
| **Transport** | Direct `fetch()` from the browser |
| **Auth header** | `anthropic-dangerous-direct-browser-access: true` |

The app makes one API call per selected analysis scope. Each call sends the extracted document text plus a structured system prompt defining the scope. Responses are parsed as numbered finding lists. Retry logic handles 429/529 rate-limit responses with exponential backoff (15s, 30s, 45s).

> ⚠️ **Production note:** Direct browser-to-API calls expose your API key to the client. For multi-user deployments, add a thin backend proxy to keep the key server-side.

### Document Processing (client-side)

| Library | Source | Purpose |
|---|---|---|
| **PDF.js** (Mozilla) | CDN | Extracts plain text from uploaded PDFs in the browser — no page limit, no server upload |
| **JSZip** | CDN | Reads and writes `.docx` files (OOXML ZIP archives) entirely in the browser |

Both libraries are loaded at runtime from CDN — they are not bundled into the app.

### Word Export (`.docx`)

The Word export pipeline works entirely in the browser:

1. The default template is embedded in the JS bundle as a **base64-encoded string**
2. `JSZip` decodes and opens the template (which is a ZIP of XML files)
3. `word/document.xml` is parsed and content is injected via string manipulation
4. SharePoint metadata (`customXml/`), attached template references, and external schema links are stripped to ensure clean cross-environment compatibility
5. The modified ZIP is re-encoded and downloaded as a `.docx` file

The default template was generated with **python-docx** (Python, build-time only) to produce a clean OOXML-compliant base with all required styles: `Heading1`, `Heading2`, `BodyText`, `ListBullet`, `TableHeader`, `TableText`, `TableGrid`.

Users can also upload a custom `.docx` template. The app scans its `word/styles.xml` to detect actual style IDs and maps generated content to the correct styles automatically.

### File Formats

| Format | Usage |
|---|---|
| **OOXML / `.docx`** | Office Open XML — Word documents are ZIP archives of XML; we manipulate `word/document.xml` directly |
| **PDF** | Input format; parsed client-side with PDF.js |
| **Base64** | Default Word template is embedded in the JS bundle |
| **Plain text / Clipboard** | Additional export formats |

### Runtime & Deployment

| Technology | Role |
|---|---|
| **Docker** | Container packaging for deployment |
| **Nginx** | Static file server inside the Docker container |
| **Node.js** | Build-time only — not present at runtime |

The production build (`npm run build`) outputs plain HTML, JS, and CSS files. Nginx serves these with no dynamic server-side logic whatsoever.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                    Browser (Client)                  │
│                                                     │
│  ┌──────────────┐   ┌──────────┐   ┌────────────┐  │
│  │   React UI   │   │  PDF.js  │   │   JSZip    │  │
│  │  (App.jsx)   │   │ (CDN)    │   │   (CDN)    │  │
│  └──────┬───────┘   └────┬─────┘   └─────┬──────┘  │
│         │                │               │          │
│         │ fetch()        │ parse PDF     │ .docx    │
│         ▼                ▼               ▼          │
│  ┌─────────────┐  ┌───────────┐  ┌────────────────┐ │
│  │ Anthropic   │  │ Uploaded  │  │ Word Template  │ │
│  │ Claude API  │  │ PDF File  │  │ (base64 embed) │ │
│  └─────────────┘  └───────────┘  └────────────────┘ │
└─────────────────────────────────────────────────────┘
                        │
              Docker + Nginx
              (serves static files)
```

---

## Project Structure

```
release-lens/
├── src/
│   └── App.jsx          # Entire application — single component file
├── public/
│   └── index.html       # HTML shell
├── package.json         # Node dependencies (React, Vite)
├── vite.config.js       # Build configuration
├── Dockerfile           # Container definition
├── nginx.conf           # Nginx static server config
├── README.md            # Project overview
└── TECHNICAL.md         # This file
```

---

## Key Design Decisions

**Single-file component** — the entire app lives in `App.jsx`. For a tool of this scope this keeps navigation simple and avoids over-engineering.

**No backend** — eliminates infrastructure complexity. The tradeoff is API key exposure in the browser, acceptable for internal/personal use but requiring a proxy for public deployments.

**Inline styles over CSS framework** — avoids class name collisions, keeps styles co-located with components, and requires no CSS build step.

**CDN libraries over bundled** — PDF.js and JSZip are large; loading them from CDN on demand keeps the initial bundle small and fast.

**Direct OOXML manipulation** — rather than using a Word library, content XML is injected as strings into the template's `document.xml`. This is brittle but gives full control over the output structure and avoids large dependencies.

---

## Credits

| Role | |
|---|---|
| **Concept & Requirements** | Java4all |
| **Code** | Claude AI (Anthropic) |
| **License** | MIT — open source |

---

*For usage instructions see [README.md](./README.md)*
