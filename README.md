# ReleaseLens — AI Release Analysis Platform

Analyse vendor documentation (PDF or URL) with Claude AI across custom scopes:
New Features · Deprecated · Deployment Changes · Security · Breaking Changes · Migration Guide · Custom Scope

---

## Quick Start with Docker

### 1. Get an Anthropic API key
Sign up at https://console.anthropic.com and create an API key.

### 2. Set your API key
```bash
cp .env.example .env
# Edit .env and replace the placeholder with your real key
```

### 3. Build and run (one command)
```bash
 docker-compose down && docker compose up --build
```

Open http://localhost:4173 in your browser.

---

## Without Docker Compose (plain Docker)

```bash
# Build
docker build \
  --build-arg VITE_ANTHROPIC_API_KEY=sk-ant-your-key-here \
  -t release-intel .

# Run
docker run -p 4173:4173 release-intel
```

---

## Local Development (no Docker)

```bash
cp .env.example .env   # add your key
npm install
npm run dev            # runs on http://localhost:5173
```

---

## Project Structure

```
release-intel/
├── src/
│   ├── App.jsx        # Main ReleaseLens component (all UI + AI logic)
│   └── main.jsx       # React entry point
├── index.html
├── vite.config.js
├── package.json
├── Dockerfile         # Multi-stage build (node:20-alpine)
├── docker-compose.yml
├── .env.example       # Copy to .env and add your API key
└── template_example.docx # Example of custom Word template 
```

## How the API key works

The Anthropic API key is injected at **build time** via the `VITE_ANTHROPIC_API_KEY`
environment variable. Vite embeds it into the compiled JS bundle.

> ⚠️ Do not commit your `.env` file or share the built image publicly —
> the key is embedded in the bundle.
