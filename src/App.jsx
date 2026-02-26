import { useState, useRef, useEffect } from "react";

// ─── API Key (injected via VITE_ANTHROPIC_API_KEY env var) ───────────────────
const API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";

// ─── Constants ────────────────────────────────────────────────────────────────

const ANALYSIS_SCOPES = [
  { id: "new_features",       label: "New & Changed Features",   icon: "✦", color: "#00D4FF" },
  { id: "deprecated",         label: "Deprecated Features",       icon: "⊘", color: "#FF6B6B" },
  { id: "deployment_changes", label: "Deployment Changes",        icon: "⟳", color: "#A78BFA" },
  { id: "security",           label: "Security & Compliance",     icon: "⬡", color: "#34D399" },
  { id: "breaking_changes",   label: "Breaking Changes",          icon: "⚡", color: "#FBBF24" },
  { id: "migration_guide",    label: "Migration Guide",           icon: "→", color: "#F472B6" },
];

const SCOPE_PROMPTS = {
  new_features:
    "Identify and list every NEW feature, NEW section, NEW capability, or UPDATED/CHANGED behaviour documented. Format EACH finding as: 'Short Title (New/Updated): Full detail sentence explaining what changed and why it matters operationally.' The Short Title should be 3-8 words, title-case, describing the feature name — like 'RHEL Deployment Support (New)' or 'Dual-Homing Deployment (New)' or 'Access Configuration Requirements (Updated)'. The full detail follows after the colon.",
  deprecated:
    "Identify every DEPRECATED, REMOVED, PROHIBITED, or SUPERSEDED feature, parameter, method, or document section. Note what replaces each item where documented.",
  deployment_changes:
    "Identify every change to deployment procedures, installation methods, scripts, parameters, environments, or topology options. Format EACH finding as: 'Section Name — Nature of Change — Operational impact description.' For example: 'Run deployment script (RHEL) — New section added — New deployment path requires RHEL-specific cert path and PRE_INSTALL_EPHEMERAL_STORAGE parameter.' Nature of Change should be one of: New section added, Updated, Fully replaced, Removed.",
  security:
    "Extract all security requirements, compliance mandates, credential rules, certificate requirements, encryption requirements, and security warnings or cautions.",
  breaking_changes:
    "Identify changes that would BREAK existing deployments or workflows if teams follow previous documentation. Flag anything requiring immediate action or configuration changes.",
  migration_guide:
    "Summarise what teams migrating from a previous version must do differently. Format EACH finding as: 'Short Area Name — Action required description — Priority' where Priority is one of: Critical, High, Medium. Example: 'Access key & PIN — Ensure only the Administrator account credentials are used, never deployment engineers — Critical'. Keep the Area Name short (2-5 words).",
};

const SAMPLE_HISTORY = [
  { id: 1, title: "Dell DAP 1.x Deployment Guide",    date: "Feb 2026", url: "https://www.dell.com/support/kbdoc/en-us/000224359/dell-apex-software-platform-deployment-guide", scopes: ["New & Changed Features", "Deprecated Features", "Deployment Changes"] },
  { id: 2, title: "VMware vSphere 8.0 Release Notes", date: "Jan 2026", url: "https://docs.vmware.com/en/VMware-vSphere/8.0/rn/vmware-vsphere-80-release-notes/index.html", scopes: ["Breaking Changes", "Security & Compliance"] },
  { id: 3, title: "Kubernetes 1.30 Migration Guide",  date: "Dec 2025", url: "https://kubernetes.io/docs/concepts/overview/kubernetes-api/#api-versioning", scopes: ["Migration Guide", "Deprecated Features"] },
];

// ─── Utilities ────────────────────────────────────────────────────────────────

// Extract all text from a PDF File using PDF.js (loaded from CDN once).
// Returns a plain string with all page text concatenated.
// This approach has NO page limit — we send text to Claude, not binary PDF.
async function extractPdfText(file, onProgress) {
  // Load PDF.js from CDN if not already present
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;
  const texts = [];

  for (let i = 1; i <= totalPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(" ");
    texts.push(`[Page ${i}]\n${pageText}`);
    onProgress && onProgress(i, totalPages);
  }

  return texts.join("\n\n");
}

// Haiku rate limit: 50k TPM. Prompt overhead ~1.5k tokens, output ~1k tokens.
// Safe content budget: ~10k tokens = ~40000 chars per call.
// For large docs, sample head + tail — where release notes & changelogs live.
const CONTENT_BUDGET = 40000;
function prepareDocText(text) {
  if (text.length <= CONTENT_BUDGET) return text;
  const half = Math.floor(CONTENT_BUDGET / 2);
  return text.slice(0, half)
    + "\n\n[... middle section omitted — document too large for single call ...]\n\n"
    + text.slice(-half);
}

function parseBullets(raw) {
  return raw
    .split("\n")
    .map(l => l.replace(new RegExp("^[\s\-•*\d.)\]]+"), "").trim())
    .filter(l => l.length > 10);
}

function deduplicateBullets(bullets) {
  const seen = [];
  const out  = [];
  for (const b of bullets) {
    const key = b.toLowerCase().replace(new RegExp("\s+", "g"), " ").slice(0, 60);
    if (!seen.some(k => k === key)) { seen.push(key); out.push(b); }
  }
  return out;
}

// ─── Shared UI atoms ──────────────────────────────────────────────────────────

function PulsingDot({ color }) {
  return (
    <span style={{ display:"inline-block", position:"relative", width:10, height:10 }}>
      <span style={{ position:"absolute", inset:0, borderRadius:"50%", background:color, animation:"ping 1.2s cubic-bezier(0,0,0.2,1) infinite" }} />
      <span style={{ position:"absolute", inset:2, borderRadius:"50%", background:color }} />
    </span>
  );
}

function BulletLine({ text, color }) {
  return (
    <div style={{ display:"flex", gap:10, marginBottom:9, alignItems:"flex-start", animation:"fadeSlide 0.35s ease" }}>
      <span style={{ color, fontSize:9, marginTop:6, flexShrink:0 }}>◆</span>
      <span style={{ color:"rgba(255,255,255,0.84)", fontSize:13.5, lineHeight:1.68, fontFamily:"'DM Sans',sans-serif" }}>{text}</span>
    </div>
  );
}

function StreamingBlock({ scope, bullets, isStreaming }) {
  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
        <span style={{ background:`linear-gradient(135deg,${scope.color}33,${scope.color}11)`, border:`1px solid ${scope.color}66`, borderRadius:6, padding:"4px 13px", color:scope.color, fontSize:11, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase", fontFamily:"'JetBrains Mono',monospace" }}>
          {scope.icon} {scope.label}
        </span>
        {isStreaming && (
          <span style={{ display:"flex", gap:3 }}>
            {[0,1,2].map(i => <span key={i} style={{ width:4, height:4, borderRadius:"50%", background:scope.color, display:"inline-block", animation:`bounce 1s ease infinite`, animationDelay:`${i*0.15}s` }} />)}
          </span>
        )}
      </div>
      <div style={{ background:"rgba(255,255,255,0.025)", border:"1px solid rgba(255,255,255,0.07)", borderLeft:`3px solid ${scope.color}88`, borderRadius:"0 10px 10px 0", padding:"16px 20px", minHeight: isStreaming && bullets.length===0 ? 52 : "auto" }}>
        {bullets.map((b, i) => <BulletLine key={i} text={b} color={scope.color} />)}
        {isStreaming && bullets.length === 0 && (
          <span style={{ color:"rgba(255,255,255,0.28)", fontSize:12, fontFamily:"'JetBrains Mono',monospace" }}>Analysing…</span>
        )}
      </div>
    </div>
  );
}

function ErrorBanner({ msg, onClose }) {
  return (
    <div style={{ position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)", background:"#140a0a", border:"1px solid rgba(255,107,107,0.4)", borderRadius:10, padding:"14px 20px", zIndex:999, display:"flex", alignItems:"center", gap:12, maxWidth:540, boxShadow:"0 8px 32px rgba(0,0,0,0.5)" }}>
      <span style={{ color:"#FF6B6B", fontSize:16 }}>⚠</span>
      <span style={{ color:"rgba(255,255,255,0.8)", fontSize:13, flex:1 }}>{msg}</span>
      <button onClick={onClose} style={{ background:"none", border:"none", color:"rgba(255,255,255,0.4)", cursor:"pointer", fontSize:18 }}>×</button>
    </div>
  );
}


// ─── Export Functions ─────────────────────────────────────────────────────────

// Default template embedded as base64 (General_Release_Summary_Template.docx)
const DEFAULT_TEMPLATE_B64 = "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";

// Load JSZip – bundled via npm (jszip in package.json)
async function loadJSZip() {
  if (window._JSZipCached) return window._JSZipCached;
  const mod = await import("jszip");
  window._JSZipCached = mod.default || mod;
  return window._JSZipCached;
}

// ── Default style IDs (General_Release_Summary_Template.docx) ────────────
const DEFAULT_STYLES = {
  h1:"Heading1", h2:"Heading2", body:"BodyText", bullet:"ListBullet",
  tableHeader:"TableHeader", tableText:"TableText", tableGrid:"TableGrid", fill:"0073E6",
};

// ── Detect style IDs from any uploaded template's styles.xml ─────────────
async function detectTemplateStyles(buf) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buf);
  if (!zip.files["word/styles.xml"]) return { ...DEFAULT_STYLES };
  const xml = await zip.files["word/styles.xml"].async("string");
  const map = {};
  let m, re = new RegExp('<w:style\\b[^>]*w:styleId="([^"]+)"[^>]*>([\\s\\S]*?)<\\/w:style>', 'g');
  while ((m = re.exec(xml)) !== null) {
    const nm = (new RegExp('<w:name\\b[^>]*w:val="([^"]+)"').exec(m[2]) || [])[1] || "";
    map[m[1]] = nm.toLowerCase().trim();
  }
  const pick = (...pats) => { for (const [id,name] of Object.entries(map)) for (const p of pats) if (typeof p==="string"?name===p:p.test(name)) return id; return null; };
  let fill = DEFAULT_STYLES.fill;
  if (zip.files["word/document.xml"]) { const d = await zip.files["word/document.xml"].async("string"); const fm = d.match(new RegExp('w:fill="([0-9A-Fa-f]{6})"')); if (fm) fill = fm[1].toUpperCase(); }
  const rH1   = new RegExp("^heading\\s*1$");
  const rH2   = new RegExp("^heading\\s*2$");
  const rBody = new RegExp("^body");
  const rBul  = new RegExp("^list\\s*bullet");
  const rTH   = new RegExp("^table\\s*head");
  const rTHid = new RegExp("^tableheader");
  const rTT   = new RegExp("^table\\s*text");
  const rTTid = new RegExp("^tabletext");
  const rTG   = new RegExp("^table\\s*grid");
  return {
    h1:          pick("heading 1", rH1)                 || DEFAULT_STYLES.h1,
    h2:          pick("heading 2", rH2)                 || DEFAULT_STYLES.h2,
    body:        pick("body text", "bodytext", rBody)   || DEFAULT_STYLES.body,
    bullet:      pick("list bullet", rBul)              || DEFAULT_STYLES.bullet,
    tableHeader: pick("table header", rTHid, rTH)       || DEFAULT_STYLES.tableHeader,
    tableText:   pick("table text", rTTid, rTT)         || DEFAULT_STYLES.tableText,
    tableGrid:   pick("table grid", rTG, "normal table") || DEFAULT_STYLES.tableGrid,
    fill,
  };
}

// ── XML helpers (accept optional st=styles object) ────────────────────────
function xmlEsc(s) {
  return String(s).replace(new RegExp("&","g"),"&amp;").replace(new RegExp("<","g"),"&lt;").replace(new RegExp(">","g"),"&gt;").replace(new RegExp('"',"g"),"&quot;");
}
function xmlH1(text, st=DEFAULT_STYLES) {
  return `<w:p><w:pPr><w:pStyle w:val="${st.h1}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
}
function xmlH2(text, st=DEFAULT_STYLES) {
  return `<w:p><w:pPr><w:pStyle w:val="${st.h2}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
}
function xmlBody(text, st=DEFAULT_STYLES) {
  return `<w:p><w:pPr><w:pStyle w:val="${st.body}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
}
function xmlBullet(text, st=DEFAULT_STYLES) {
  return `<w:p><w:pPr><w:pStyle w:val="${st.bullet}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
}
function xmlSpacer(st=DEFAULT_STYLES) {
  return `<w:p><w:pPr><w:pStyle w:val="${st.body}"/></w:pPr></w:p>`;
}
function xmlTable3(cols, rows, st=DEFAULT_STYLES) {
  const totalW = cols.reduce((s,c)=>s+c.w,0);
  const hdrCells = cols.map(c =>
    `<w:tc><w:tcPr><w:tcW w:w="${c.w}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${st.fill}"/></w:tcPr>` +
    `<w:p><w:pPr><w:pStyle w:val="${st.tableHeader}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEsc(c.label)}</w:t></w:r></w:p></w:tc>`
  ).join("");
  const dataRows = rows.map(row =>
    `<w:tr>${row.map((cell,i) =>
      `<w:tc><w:tcPr><w:tcW w:w="${cols[i].w}" w:type="dxa"/></w:tcPr>` +
      `<w:p><w:pPr><w:pStyle w:val="${st.tableText}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEsc(cell)}</w:t></w:r></w:p></w:tc>`
    ).join("")}</w:tr>`
  ).join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="${st.tableGrid}"/><w:tblW w:w="${totalW}" w:type="dxa"/>` +
    `<w:tblLook w:val="04A0" w:firstRow="1"/></w:tblPr>` +
    `<w:tblGrid>${cols.map(c=>`<w:gridCol w:w="${c.w}"/>`).join("")}</w:tblGrid>` +
    `<w:tr>${hdrCells}</w:tr>${dataRows}</w:tbl>`;
}

// Parse priority from text
function parsePriority(text) {
  if (new RegExp("critical","i").test(text)) return "Critical";
  if (new RegExp("high","i").test(text)) return "High";
  if (new RegExp("medium","i").test(text)) return "Medium";
  return "High";
}

// Parse status from deprecated finding
function parseDepStatus(text) {
  if (new RegExp("prohibit","i").test(text) || new RegExp("must not","i").test(text) || new RegExp("never.*set","i").test(text)) return "Prohibited";
  if (new RegExp("replac|supersed","i").test(text)) return "Replaced";
  if (new RegExp("merg","i").test(text)) return "Merged/Superseded";
  if (new RegExp("remov","i").test(text)) return "Removed";
  return "Deprecated";
}

// Parse deployment nature from text
function parseNature(text) {
  if (new RegExp("new section","i").test(text)) return "New section added";
  if (new RegExp("fully replac","i").test(text)) return "Fully replaced";
  if (new RegExp("remov","i").test(text)) return "Removed";
  return "Updated";
}

// ── Build content XML per scope ────────────────────────────────────────────
function buildScopeXml(scope, bullets, st=DEFAULT_STYLES) {
  if (!bullets.length) {
    return xmlH1(scope.label, st) +
      xmlBody(`No ${scope.label.toLowerCase()} identified in this document.`, st) +
      xmlSpacer(st);
  }

  const W = 8959; // content width in DXA

  switch (scope.id) {

    case "new_features": {
      // H1 → intro → H2 per feature + body paragraph
      let xml = xmlH1("New or Changed Features", st) +
        xmlBody("The following features and sections were added or significantly updated in this release.", st) +
        xmlSpacer(st);
      bullets.forEach(b => {
        const colonIdx = b.indexOf(":");
        let title, detail;
        if (colonIdx > 5 && colonIdx < 80) {
          title  = b.slice(0, colonIdx).trim();
          detail = b.slice(colonIdx + 1).trim();
        } else {
          const dash = b.search(new RegExp("\s[—–]\s"));
          title  = dash > 5 ? b.slice(0, dash).trim() : b.slice(0, 60).trim();
          detail = dash > 5 ? b.slice(dash).replace(new RegExp("^\s*[—–]\s*"), "") : "";
        }
        xml += xmlH2(title, st) + xmlBody(detail, st) + xmlSpacer(st);
      });
      return xml;
    }

    case "deprecated": {
      // H1 → intro → 3-col table (Item | Status | Notes)
      const rows = bullets.map(b => {
        const parts = b.split(new RegExp("\s+[—–]\s+"));
        const item  = parts[0]?.trim() || b.slice(0, 60);
        const notes = parts.slice(1).join(" — ").trim() || b;
        const status = parseDepStatus(b);
        return [item, status, notes];
      });
      return xmlH1("Deprecated or Removed Features", st) +
        xmlBody("The following items have been removed or superseded in this release.", st) +
        xmlSpacer(st) +
        xmlTable3([{ label: "Item", w: 3200 }, { label: "Status", w: 1500 }, { label: "Notes", w: 4259 }],
          rows, st) + xmlSpacer(st);
    }

    case "deployment_changes": {
      // H1 → intro → 3-col table (Changed Section | Nature | Impact)
      const rows = bullets.map(b => {
        const parts = b.split(new RegExp("\s+[—–]\s+"));
        const section = parts[0]?.trim() || b.slice(0, 50);
        const nature  = parts[1] ? parseNature(parts[1]) : parseNature(b);
        const impact  = parts[2]?.trim() || parts[1]?.trim() || "";
        return [section, nature, impact];
      });
      return xmlH1("Deployment Guide Update Notes", st) +
        xmlBody("The following items represent notable changes that impact how deployments should be executed.", st) +
        xmlSpacer(st) +
        xmlTable3([{ label: "Changed Section", w: 3136 }, { label: "Nature of Change", w: 1800 }, { label: "Operational Impact", w: 4023 }],
          rows, st) + xmlSpacer(st);
    }

    case "security": {
      // H1 → intro → 3-col table (Requirement | Severity | Action)
      const rows = bullets.map(b => {
        const sev = new RegExp("critical","i").test(b) ? "Critical" : new RegExp("high","i").test(b) ? "High" : "Medium";
        return [b, sev, "Verify compliance"];
      });
      return xmlH1("Security & Compliance Requirements", st) +
        xmlBody("The following security requirements, credential rules, and compliance mandates were identified.", st) +
        xmlSpacer(st) +
        xmlTable3([{ label: "Security Requirement", w: 5500 }, { label: "Severity", w: 1600 }, { label: "Action", w: 1859 }],
          rows, st) + xmlSpacer(st);
    }

    case "breaking_changes": {
      // H1 → warning body → bullets
      let xml = xmlH1("Breaking Changes", st) +
        xmlBody("The following changes may break existing deployments if previous documentation was followed. Immediate review is required.", st) +
        xmlSpacer(st);
      bullets.forEach(b => { xml += xmlBullet(b, st); });
      return xml + xmlSpacer(st);
    }

    case "migration_guide": {
      // H1 → intro → 3-col table (Area | Action Required | Priority)
      const rows = bullets.map(b => {
        const parts = b.split(new RegExp("\s+[—–]\s+"));
        const area   = parts[0]?.trim() || b.slice(0, 30);
        const action = parts[1]?.trim() || b;
        const pri    = parsePriority(parts[2] || b);
        return [area, action, pri];
      });
      return xmlH1("Summary: Key Actions for Deployment Teams", st) +
        xmlBody("The following actions are required when migrating from the previous release.", st) +
        xmlSpacer(st) +
        xmlTable3([{ label: "Area", w: 2400 }, { label: "Action Required", w: 5159 }, { label: "Priority", w: 1400 }],
          rows, st) + xmlSpacer(st);
    }

    default: {
      let xml = xmlH1(scope.label, st) + xmlSpacer(st);
      bullets.forEach(b => { xml += xmlBullet(b, st); });
      return xml + xmlSpacer(st);
    }
  }
}

// ── Find template injection point robustly ────────────────────────────────
// Strategy: inject after last </w:p> before the final sectPr.
// Works for both single-section and multi-section templates.
function findInjectionBounds(docXml) {
  // The final sectPr is the page-layout section — always a direct child of w:body
  const lastSectStart = docXml.lastIndexOf("<w:sectPr");

  // Inject after the last </w:p> before that sectPr (preserves cover page)
  const lastParaEnd = docXml.lastIndexOf("</w:p>", lastSectStart);
  const prefixEnd = lastParaEnd !== -1 ? lastParaEnd + "</w:p>".length : lastSectStart;

  return { prefixEnd, suffixStart: lastSectStart };
}

// ── Update cover page title in template ──────────────────────────────────
function updateCoverTitle(docXml, docTitle) {
  if (!docTitle?.title) return docXml;
  // Find the Title-style paragraph and replace its text content
  // The template has: <w:pStyle w:val="Title"/>
  const titleStyleIdx = docXml.indexOf('w:val="Title"');
  if (titleStyleIdx === -1) return docXml;

  // Find the paragraph start before this style tag
  const paraStart = docXml.lastIndexOf("<w:p>", titleStyleIdx);
  const paraStart2 = docXml.lastIndexOf("<w:p ", titleStyleIdx);
  const pStart = Math.max(paraStart, paraStart2);
  const pEnd = docXml.indexOf("</w:p>", titleStyleIdx) + "</w:p>".length;
  if (pStart === -1 || pEnd === -1) return docXml;

  const newTitlePara =
    `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>` +
    `<w:r><w:t xml:space="preserve">${xmlEsc(docTitle.title.toUpperCase())}` +
    (docTitle.subtitle ? ` - ${xmlEsc(docTitle.subtitle.toUpperCase())}` : "") +
    `</w:t></w:r></w:p>`;

  return docXml.slice(0, pStart) + newTitlePara + docXml.slice(pEnd);
}

// ── Main template-based export function ──────────────────────────────────
async function exportWithTemplate(templateBuffer, scopeList, resultMap, docName, docTitle = {}, st = DEFAULT_STYLES) {
  const JSZip = await loadJSZip();

  // Load and unpack template
  const zip = await JSZip.loadAsync(templateBuffer);

  // ── Strip SharePoint customXml (causes "Word experienced an error" outside SharePoint) ──
  const customXmlKeys = Object.keys(zip.files).filter(k => k.startsWith("customXml/"));
  customXmlKeys.forEach(k => delete zip.files[k]);

  // Remove customXml relationship entries from document.xml.rels
  if (zip.files["word/_rels/document.xml.rels"]) {
    const dr = await zip.files["word/_rels/document.xml.rels"].async("string");
    const cleanDr = dr.replace(new RegExp('<Relationship[^>]*relationships/customXml[^>]*/>', "g"), "");
    zip.file("word/_rels/document.xml.rels", cleanDr);
  }

  // Remove customXml Override entries from [Content_Types].xml
  if (zip.files["[Content_Types].xml"]) {
    const ct = await zip.files["[Content_Types].xml"].async("string");
    const cleanCt = ct.replace(new RegExp('<Override[^>]*/customXml/[^>]*/>', "g"), "");
    zip.file("[Content_Types].xml", cleanCt);
  }

  // Fix broken attached template reference (common in corporate templates)
  if (zip.files["word/_rels/settings.xml.rels"]) {
    const rel = await zip.files["word/_rels/settings.xml.rels"].async("string");
    const fixed = rel.replace(new RegExp("<Relationship[^>]*[.]dotm[^/]*/>","g"), "");
    zip.file("word/_rels/settings.xml.rels", fixed);
  }
  if (zip.files["word/settings.xml"]) {
    const s = await zip.files["word/settings.xml"].async("string");
    zip.file("word/settings.xml", s.replace(new RegExp("<w:attachedTemplate[^/]*/>","g"), ""));
  }

  // Read and patch document.xml
  let docXml = await zip.files["word/document.xml"].async("string");

  // Update cover page title
  docXml = updateCoverTitle(docXml, docTitle);

  // Find injection bounds
  const { prefixEnd, suffixStart } = findInjectionBounds(docXml);
  const prefix = docXml.slice(0, prefixEnd);
  const suffix = docXml.slice(suffixStart);

  // Build all scope content XML
  const contentXml = scopeList
    .map(scope => buildScopeXml(scope, resultMap[scope.id] || [], st))
    .join("");

  // Assemble final document XML
  const newDocXml = prefix + contentXml + suffix;
  zip.file("word/document.xml", newDocXml);

  // Generate and download
  const out = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const url = URL.createObjectURL(out);
  const a   = document.createElement("a");
  a.href     = url;
  const safeName = (docTitle?.title || docName || "analysis")
    .replace(new RegExp("[^a-z0-9]","gi"), "_").slice(0, 40);
  a.download = `ReleaseLens_${safeName}_${new Date().toISOString().slice(0, 10)}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Convert base64 string to ArrayBuffer ─────────────────────────────────
function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}


// Generate and download a rich plain-text report
function exportToTxt(scopeList, resultMap, docName, totalFindings, docTitle = {}) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
  const sourceLabel = docTitle?.title || docName || "Vendor Documentation";
  const sourceSubtitle = docTitle?.subtitle || "Release Analysis & Change Summary";
  const sourceRevision = docTitle?.revision || "";
  const line = (char, len = 72) => char.repeat(len);

  const lines = [
    line("="),
    "  RELEASE INTELLIGENCE REPORT",
    `  ${sourceLabel}`,
    ...(sourceSubtitle ? [`  ${sourceSubtitle}`] : []),
    ...(sourceRevision ? [`  Revision: ${sourceRevision}`] : []),
    line("="),
    `  Generated : ${dateStr}`,
    `  Findings  : ${totalFindings} across ${scopeList.length} scope modules`,
    `  Engine    : Claude AI (Anthropic) via ReleaseLens`,
    line("="),
    "",
    "EXECUTIVE SUMMARY",
    line("-"),
    `This report contains AI-extracted findings from "${sourceLabel}".`,
    `${scopeList.length} analysis modules were run, yielding ${totalFindings} total findings.`,
    "",
    "SCOPE OVERVIEW",
    line("-"),
    ...scopeList.map(s => {
      const count = (resultMap[s.id] || []).length;
      const pad = " ".repeat(Math.max(1, 36 - s.label.length));
      return `  ${s.icon}  ${s.label}${pad}${count} finding${count !== 1 ? "s" : ""}`;
    }),
    "",
    line("="),
    "",
    ...scopeList.flatMap(scope => {
      const bullets = resultMap[scope.id] || [];
      return [
        "",
        line("─"),
        `${scope.icon}  ${scope.label.toUpperCase()}`,
        line("─"),
        bullets.length === 0
          ? "  No findings identified for this scope."
          : "",
        ...bullets.map((b, i) => [
          `  [${String(i + 1).padStart(2, "0")}]  ${b}`,
          "",
        ]).flat(),
      ];
    }),
    "",
    line("="),
    "  END OF REPORT",
    line("="),
  ];

  const text = lines.join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ReleaseLens_${(docName || "analysis").replace(new RegExp("[^a-z0-9]","gi"), "_").slice(0, 40)}_${now.toISOString().slice(0,10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReleaseLens() {
  // Navigation
  const [step, setStep] = useState("home"); // home | confirm | analyzing | results

  // Input state
  const [docType, setDocType]       = useState("pdf");
  const [urlInput, setUrlInput]     = useState("");
  const [file, setFile]             = useState(null);
  const [fileName, setFileName]     = useState("");
  const [docTitle, setDocTitle]      = useState({ title: "", subtitle: "", revision: "" });
  const [selectedScopes, setSelectedScopes] = useState(new Set(["new_features","deprecated","deployment_changes"]));
  const [customScopes, setCustomScopes]     = useState([]);         // [{ id, label, color, icon }]
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customInputVal, setCustomInputVal]   = useState("");

  // Analysis state
  const [analysisPhase, setAnalysisPhase]       = useState("");
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [currentScopeIdx, setCurrentScopeIdx]   = useState(0);

  // Results state
  const [resultMap, setResultMap]     = useState({}); // { scopeId: string[] }
  const [streamingId, setStreamingId] = useState(null);
  const [activeScopeId, setActiveScopeId] = useState(null);
  const [totalFindings, setTotalFindings] = useState(0);

  const [error, setError]   = useState(null);
  const [customTemplate, setCustomTemplate] = useState(null);     // { name, buffer, styles }
  const [templateLoading, setTemplateLoading] = useState(false);
  const fileInputRef        = useRef(null);
  const templateInputRef    = useRef(null);
  const abortRef            = useRef(null);

  const handleFileSelect = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) { setFile(f); setFileName(f.name); }
  };

  const handleTemplateUpload = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setTemplateLoading(true);
    try {
      const buf = await f.arrayBuffer();
      const styles = await detectTemplateStyles(buf);
      setCustomTemplate({ name: f.name, buffer: buf, styles: styles });
    } finally {
      setTemplateLoading(false);
    }
    e.target.value = "";
  };

  const handleWordExport = async () => {
    try {
      const buf = customTemplate ? customTemplate.buffer : b64ToArrayBuffer(DEFAULT_TEMPLATE_B64);
      await exportWithTemplate(buf, scopeList, resultMap, fileName || urlInput, docTitle, customTemplate && customTemplate.styles ? customTemplate.styles : DEFAULT_STYLES);
    } catch(e) {
      alert("Export failed: " + e.message);
    }
  };

  const handleCopyText = () => {
    const text = scopeList.map(s => "## " + s.label + "\n" + (resultMap[s.id] || []).map((b, i) => (i + 1) + ". " + b).join("\n")).join("\n\n");
    navigator.clipboard.writeText(text).then(() => alert("Copied to clipboard!"));
  };

  const handleUploadBtnEnter = (e) => {
    if (!templateLoading) { e.currentTarget.style.background = "rgba(167,139,250,0.14)"; e.currentTarget.style.color = "#A78BFA"; }
  };
  const handleUploadBtnLeave = (e) => {
    e.currentTarget.style.background = "rgba(167,139,250,0.06)";
    e.currentTarget.style.color = "rgba(167,139,250,0.85)";
  };

  const CUSTOM_COLORS = ["#F59E0B","#10B981","#EC4899","#8B5CF6","#06B6D4","#EF4444","#84CC16","#F97316"];
  const CUSTOM_ICONS  = ["◈","◉","◎","⬟","⬠","◇","⬡","◆"];

  const scopeList = [
    ...[...selectedScopes].map(id => ANALYSIS_SCOPES.find(s => s.id === id)).filter(Boolean),
    ...customScopes,
  ];

  const canRun = (file || urlInput.trim()) && (selectedScopes.size > 0 || customScopes.length > 0);

  const addCustomScope = () => {
    const label = customInputVal.trim();
    if (!label) return;
    const idx = customScopes.length % CUSTOM_COLORS.length;
    const id = "custom_" + Date.now();
    setCustomScopes(prev => [...prev, { id, label, color: CUSTOM_COLORS[idx], icon: CUSTOM_ICONS[idx] }]);
    setCustomInputVal("");
    setShowCustomInput(false);
  };

  const removeCustomScope = (id) => setCustomScopes(prev => prev.filter(s => s.id !== id));

  const toggleScope = id => setSelectedScopes(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const reset = () => {
    abortRef.current?.abort();
    setStep("home"); setDocType("pdf"); setUrlInput(""); setFile(null); setFileName(""); setDocTitle({ title: "", subtitle: "", revision: "" });
    setSelectedScopes(new Set(["new_features","deprecated","deployment_changes"]));
    setResultMap({}); setStreamingId(null); setActiveScopeId(null);
    setTotalFindings(0); setError(null); setAnalysisProgress(0); setCurrentScopeIdx(0);
    setCustomScopes([]); setShowCustomInput(false); setCustomInputVal("");
    // Note: customTemplate is intentionally preserved across resets
  };

  // ── Call Claude API with text content ────────────────────────────────────
  // ── Extract human-readable title from the first ~3000 chars of doc ────────
  const extractDocTitle = async (text) => {
    try {
      const sample = text.slice(0, 3000);
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          system: "Extract the document title information from the beginning of this vendor document. Respond ONLY with a JSON object with exactly these keys: title (main product/document title, e.g. \"Dell Automation Platform 1.x\"), subtitle (document type/subtitle, e.g. \"Deployment Guide — Release Analysis & Change Summary\"), revision (revision and date string, e.g. \"A03 | February 2026\" — empty string if not found). No markdown, no explanation, just the JSON object.",
          messages: [{ role: "user", content: sample }],
        }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const raw = data.content?.map(c => c.text || "").join("") || "";
      const clean = raw.replace(new RegExp("```json|```","g"), "").trim();
      const parsed = JSON.parse(clean);
      if (parsed.title) return parsed;
    } catch (e) { /* silent — fall back to filename */ }
    return null;
  };

    const callClaudeWithText = async (scopeId, textContent, signal) => {
    const isCustom = scopeId.startsWith("custom_");
    const customLabel = isCustom ? (scopeList.find(s => s.id === scopeId)?.label || scopeId) : null;
    const scopeInstruction = isCustom
      ? `Extract all findings specifically related to: "${customLabel}". For each finding, provide a specific, actionable observation with full technical context relevant to this topic. Focus only on content directly relevant to "${customLabel}".`
      : SCOPE_PROMPTS[scopeId];
    const systemPrompt = `You are a senior technical release analyst specialising in vendor documentation.
Extract precise, actionable findings from vendor documentation.
Respond ONLY with a numbered list (one finding per line, starting with number and period).
Each finding: one complete sentence, 15-45 words, specific and technical.
No headers, no preamble, no summary - only numbered findings.
Scope: ${scopeInstruction}`;

    let resp, lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        const waitMs = attempt * 15000; // 15s, 30s, 45s
        for (let remaining = waitMs; remaining > 0; remaining -= 1000) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          setAnalysisPhase(`Rate limited — retrying in ${Math.ceil(remaining / 1000)}s…`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        signal,
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: `Analyse the following vendor documentation and extract findings for the defined scope.\n\nDOCUMENT CONTENT:\n${textContent}` }],
        }),
      });
      if (resp.status === 429 || resp.status === 529) {
        const e = await resp.json().catch(() => ({}));
        lastErr = e?.error?.message || "Rate limit exceeded";
        continue;
      }
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e?.error?.message || `API error ${resp.status}`);
      }
      lastErr = null;
      break;
    }
    if (lastErr) throw new Error(lastErr);
    const data = await resp.json();
    const raw  = data.content?.map(c => c.text || "").join("\n") || "";
    return parseBullets(raw);
  };

  // ── Analyse one scope — single call with budget-capped text ─────────────
  const callClaude = async (scopeId, docText) => {
    const controller = new AbortController();
    abortRef.current = controller;
    const trimmed = prepareDocText(docText);
    return callClaudeWithText(scopeId, trimmed, controller.signal);
  };

  // ── Fetch URL text via Claude web search ────────────────────────────────
  const fetchUrlText = async url => {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: `Retrieve and return the full text content of this documentation page verbatim: ${url}` }],
      }),
    });
    const data = await resp.json();
    return data.content?.map(c => c.text || "").join("\n") || "";
  };

  // ── Main analysis orchestrator ────────────────────────────────────────────
  const runAnalysis = async () => {
    setStep("analyzing");
    setResultMap({});
    setStreamingId(null);
    setTotalFindings(0);
    setAnalysisProgress(0);

    const phases = [
      "Reading document…",
      "Extracting text content…",
      "Indexing sections…",
      "Running semantic analysis…",
      "Generating findings…",
    ];

    let fakeP = 0;
    const ticker = setInterval(() => {
      fakeP = Math.min(fakeP + Math.random() * 1.5, 88);
      setAnalysisProgress(Math.round(fakeP));
      setAnalysisPhase(phases[Math.min(Math.floor(fakeP / 20), phases.length - 1)]);
    }, 200);

    try {
      let fullText = "";

      if (docType === "pdf" && file) {
        // Extract text from PDF — no page limit this way
        setAnalysisPhase("Loading PDF parser…");
        let pagesDone = 0;
        fullText = await extractPdfText(file, (done, total) => {
          pagesDone = done;
          setAnalysisPhase(`Extracting text: page ${done} of ${total}…`);
          setAnalysisProgress(Math.round((done / total) * 40));
        });

        if (!fullText.trim()) throw new Error("Could not extract text from PDF. The file may be scanned/image-only.");

        setAnalysisPhase(`Text extracted — ${Math.round(fullText.length / 1000)}k chars`);
        await new Promise(r => setTimeout(r, 400));
        setAnalysisPhase("Identifying document title…");
        const extracted = await extractDocTitle(fullText);
        if (extracted) setDocTitle(extracted);

      } else if (docType === "url" && urlInput.trim()) {
        setAnalysisPhase("Fetching documentation page…");
        fullText = await fetchUrlText(urlInput.trim());
        setAnalysisPhase("Identifying document title…");
        const extractedUrl = await extractDocTitle(fullText);
        if (extractedUrl) setDocTitle(extractedUrl);
      }

      clearInterval(ticker);
      setAnalysisProgress(95);
      setAnalysisPhase("Building report…");

      const ordered = [...selectedScopes];
      const initMap = {};
      ordered.forEach(id => { initMap[id] = []; });
      setResultMap(initMap);
      setStep("results");
      setActiveScopeId(ordered[0]);

      let total = 0;
      for (let i = 0; i < ordered.length; i++) {
        const scopeId = ordered[i];
        setStreamingId(scopeId);
        setCurrentScopeIdx(i);
        setActiveScopeId(scopeId);

        const bullets = await callClaude(scopeId, fullText);
        total += bullets.length;
        setTotalFindings(total);
        setResultMap(prev => ({ ...prev, [scopeId]: bullets }));

        // Pause between scopes to respect 50k TPM rate limit
        // Keep streamingId on the NEXT scope so progress bar stays visible
        if (i < ordered.length - 1) {
          const nextScopeId = ordered[i + 1];
          setStreamingId(nextScopeId);
          setCurrentScopeIdx(i + 1);
          setActiveScopeId(nextScopeId);
          const pauseSecs = 15;
          for (let s = pauseSecs; s > 0; s--) {
            setAnalysisPhase(`Rate limit pause — next scope in ${s}s…`);
            await new Promise(r => setTimeout(r, 1000));
          }
          setAnalysisPhase("");
        } else {
          setStreamingId(null);
        }
      }

    } catch (e) {
      clearInterval(ticker);
      if (e.name !== "AbortError") {
        setError(`Analysis failed: ${e.message}`);
        setStep("home");
      }
    } finally {
      clearInterval(ticker);
      setAnalysisProgress(100);
      setStreamingId(null);
    }
  };


  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh", background:"#070B14", color:"#E8EDF5", fontFamily:"'DM Sans',sans-serif", display:"flex", flexDirection:"column", position:"relative", overflow:"hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:rgba(0,212,255,0.22);border-radius:2px}
        @keyframes ping{75%,100%{transform:scale(2.2);opacity:0}}
        @keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeSlide{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
        @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
        @keyframes shimmer{0%,100%{opacity:0.4}50%{opacity:1}}
        input[type=file]{display:none}
        .scope-card:hover{background:rgba(255,255,255,0.06)!important;transform:translateX(2px)}
        .scope-card{transition:all 0.18s ease}
        .btn-glow:hover{transform:translateY(-2px);box-shadow:0 10px 36px rgba(0,212,255,0.3)!important}
        .btn-glow{transition:all 0.2s ease}

        .tab-btn{transition:all 0.15s ease}
        .tab-btn:hover{opacity:1!important}
        .exp-btn:hover{background:rgba(0,212,255,0.14)!important}
        .exp-btn{transition:background 0.15s ease}
      `}</style>

      {/* Background grid */}
      <div style={{ position:"fixed",inset:0,pointerEvents:"none",zIndex:0, backgroundImage:"linear-gradient(rgba(0,212,255,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,255,0.025) 1px,transparent 1px)", backgroundSize:"52px 52px" }} />
      <div style={{ position:"fixed",top:-220,left:-220,width:640,height:640,borderRadius:"50%",pointerEvents:"none",zIndex:0, background:"radial-gradient(circle,rgba(0,212,255,0.07) 0%,transparent 70%)" }} />
      <div style={{ position:"fixed",bottom:-200,right:-100,width:520,height:520,borderRadius:"50%",pointerEvents:"none",zIndex:0, background:"radial-gradient(circle,rgba(167,139,250,0.06) 0%,transparent 70%)" }} />

      {/* ── TOP BAR ── */}
      <div style={{ position:"relative",zIndex:10,display:"grid",gridTemplateColumns:"1fr auto 1fr",alignItems:"center",padding:"16px 36px",borderBottom:"1px solid rgba(255,255,255,0.06)",background:"rgba(7,11,20,0.85)",backdropFilter:"blur(20px)" }}>
        {/* Left: Logo */}
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <div style={{ width:42,height:42,borderRadius:11,background:"linear-gradient(135deg,#00D4FF,#0055FF)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,color:"#000",fontWeight:800 }}>⟐</div>
          <div>
            <div style={{ fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:800,letterSpacing:"-0.02em" }}>Release<span style={{ color:"#00D4FF" }}>Lens</span></div>
            <div style={{ fontSize:11,color:"rgba(255,255,255,0.38)",letterSpacing:"0.1em",textTransform:"uppercase",fontFamily:"'JetBrains Mono',monospace" }}>AI Release Analysis Platform</div>
          </div>
        </div>
        {/* Centre: badge + title — only on home */}
        {step === "home" ? (
          <div style={{ textAlign:"center" }}>
            <div style={{ display:"inline-flex",alignItems:"center",gap:6,background:"rgba(0,212,255,0.08)",border:"1px solid rgba(0,212,255,0.18)",borderRadius:100,padding:"4px 13px",marginBottom:5 }}>
              <PulsingDot color="#00D4FF" />
              <span style={{ fontSize:10,color:"#00D4FF",fontFamily:"'JetBrains Mono',monospace",letterSpacing:"0.1em" }}>POWERED BY CLAUDE AI</span>
            </div>
            <div style={{ fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,letterSpacing:"-0.02em",lineHeight:1.15,background:"linear-gradient(135deg,#fff 0%,rgba(255,255,255,0.7) 100%)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent" }}>
              Vendor Release <span style={{ background:"linear-gradient(135deg,#00D4FF,#0055FF)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent" }}>Intelligence</span>
            </div>
          </div>
        ) : <div />}
        {/* Right: status + actions */}
        <div style={{ display:"flex",alignItems:"center",gap:20,justifyContent:"flex-end" }}>
          <div style={{ display:"flex",alignItems:"center",gap:7 }}>
            <PulsingDot color="#34D399" />
            <span style={{ fontSize:11,color:"#34D399",fontFamily:"'JetBrains Mono',monospace" }}>Claude AI · Live</span>
          </div>
          {step !== "home" && (
            <button onClick={reset} style={{ background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",color:"rgba(255,255,255,0.55)",padding:"6px 16px",borderRadius:7,cursor:"pointer",fontSize:12 }}>← New Analysis</button>
          )}
        </div>
      </div>

      <div style={{ display:"flex",flex:1,position:"relative",zIndex:1,overflow:"hidden" }}>

        {/* ── SIDEBAR ── */}
        <div style={{ width:270,flexShrink:0,borderRight:"1px solid rgba(255,255,255,0.055)",background:"rgba(255,255,255,0.012)",display:"flex",flexDirection:"column" }}>
          <div style={{ padding:"24px 18px",overflow:"auto",flex:1 }}>
            <div style={{ fontSize:11,color:"rgba(255,255,255,0.45)",letterSpacing:"0.12em",textTransform:"uppercase",fontFamily:"'JetBrains Mono',monospace",marginBottom:16 }}>Recent Analyses</div>
            {SAMPLE_HISTORY.map(h => (
              <div key={h.id} style={{ padding:"12px",borderRadius:10,marginBottom:8 }}>
                <div style={{ display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:6,marginBottom:4 }}>
                  <div style={{ fontSize:13,fontWeight:600,color:"rgba(255,255,255,0.88)",lineHeight:1.35,flex:1 }}>{h.title}</div>
                  <a href={h.url} target="_blank" rel="noopener noreferrer"
                    title="Open source document"
                    style={{ flexShrink:0,marginTop:2,display:"flex",alignItems:"center",justifyContent:"center",width:22,height:22,borderRadius:6,background:"rgba(0,212,255,0.08)",border:"1px solid rgba(0,212,255,0.18)",color:"rgba(0,212,255,0.7)",textDecoration:"none",fontSize:11,transition:"all 0.15s" }}
                    onMouseEnter={e=>{e.currentTarget.style.background="rgba(0,212,255,0.18)";e.currentTarget.style.color="#00D4FF";}}
                    onMouseLeave={e=>{e.currentTarget.style.background="rgba(0,212,255,0.08)";e.currentTarget.style.color="rgba(0,212,255,0.7)";}}>
                    ↗
                  </a>
                </div>
                <div style={{ fontSize:11,color:"rgba(255,255,255,0.45)",fontFamily:"'JetBrains Mono',monospace",marginBottom:8 }}>{h.date}</div>
                <div style={{ display:"flex",flexWrap:"wrap",gap:4 }}>
                  {h.scopes.slice(0,2).map(s => <span key={s} style={{ fontSize:9,padding:"2px 7px",borderRadius:4,background:"rgba(0,212,255,0.08)",color:"#00D4FF",fontFamily:"'JetBrains Mono',monospace" }}>{s.split(" ")[0]}</span>)}
                  {h.scopes.length>2 && <span style={{ fontSize:9,color:"rgba(255,255,255,0.3)" }}>+{h.scopes.length-2}</span>}
                </div>
              </div>
            ))}
            <div style={{ marginTop:28,padding:"18px 16px",borderRadius:12,background:"rgba(0,212,255,0.04)",border:"1px solid rgba(0,212,255,0.1)" }}>
              <div style={{ fontSize:11,color:"#00D4FF",fontFamily:"'JetBrains Mono',monospace",marginBottom:8 }}>📊 Session</div>
              <div style={{ fontSize:32,fontWeight:700,fontFamily:"'Syne',sans-serif",color:"white" }}>{totalFindings}</div>
              <div style={{ fontSize:12,color:"rgba(255,255,255,0.5)",marginTop:3 }}>findings extracted</div>
            </div>
          </div>
        </div>

        {/* ── MAIN CONTENT ── */}
        <div style={{ flex:1,overflow:"auto",padding:"40px 56px" }}>

          {/* ════════════ HOME ════════════ */}
          {step === "home" && (
            <div style={{ maxWidth:780,margin:"0 auto" }}>
              <p style={{ color:"rgba(255,255,255,0.52)",fontSize:15,lineHeight:1.7,maxWidth:560,marginBottom:36 }}>
                Upload vendor documentation or paste a URL. Choose your analysis scope. Get structured, AI-generated release intelligence in seconds.
              </p>

              {/* Step 1: Document */}
              <div style={{ background:"rgba(255,255,255,0.032)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:14,padding:"16px 18px",marginBottom:14 }}>
                <div style={{ fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.5)",letterSpacing:"0.1em",textTransform:"uppercase",fontFamily:"'JetBrains Mono',monospace",marginBottom:10 }}>01 — Document Source</div>
                <div style={{ display:"flex",gap:8,marginBottom:10 }}>
                  {["pdf","url"].map(t => (
                    <button key={t} onClick={()=>setDocType(t)} style={{ padding:"5px 16px",borderRadius:7,cursor:"pointer",fontFamily:"'JetBrains Mono',monospace",fontSize:11,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",transition:"all 0.15s ease",
                      border: docType===t ? "1px solid rgba(0,212,255,0.5)" : "1px solid rgba(255,255,255,0.1)",
                      background: docType===t ? "rgba(0,212,255,0.1)" : "transparent",
                      color: docType===t ? "#00D4FF" : "rgba(255,255,255,0.36)" }}>
                      {t==="pdf" ? "📄 PDF Upload" : "🔗 URL / Link"}
                    </button>
                  ))}
                </div>

                {docType === "pdf" ? (
                  <div
                    onClick={()=>fileInputRef.current?.click()}
                    style={{ border:"2px dashed rgba(0,212,255,0.22)",borderRadius:10,padding:"16px 16px",textAlign:"center",cursor:"pointer",background:fileName?"rgba(0,212,255,0.04)":"transparent",transition:"all 0.2s ease",display:"flex",alignItems:"center",gap:12 }}
                    onMouseEnter={e=>e.currentTarget.style.borderColor="rgba(0,212,255,0.45)"}
                    onMouseLeave={e=>e.currentTarget.style.borderColor="rgba(0,212,255,0.2)"}
                  >
                    <input ref={fileInputRef} type="file" accept=".pdf" onChange={handleFileSelect} />
                    {fileName ? (
                      <><div style={{ fontSize:20 }}>📄</div><div><div style={{ color:"#00D4FF",fontSize:13,fontWeight:600 }}>{fileName}</div><div style={{ color:"rgba(255,255,255,0.3)",fontSize:11 }}>Click to change</div></div></>
                    ) : (
                      <><div style={{ fontSize:22,animation:"float 3s ease-in-out infinite" }}>⬆</div><div style={{ textAlign:"left" }}><div style={{ color:"rgba(255,255,255,0.75)",fontSize:13 }}>Click to upload PDF</div><div style={{ color:"rgba(255,255,255,0.38)",fontSize:11 }}>Deployment guides, release notes, changelogs</div></div></>
                    )}
                  </div>
                ) : (
                  <input
                    value={urlInput}
                    onChange={e=>setUrlInput(e.target.value)}
                    placeholder="https://docs.vendor.com/release-notes/v2-5…"
                    style={{ width:"100%",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"10px 14px",color:"white",fontSize:13,fontFamily:"'JetBrains Mono',monospace",transition:"border-color 0.2s ease" }}
                    onFocus={e=>e.target.style.borderColor="rgba(0,212,255,0.5)"}
                    onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}
                  />
                )}
              </div>

              {/* Step 2: Scope */}
              <div style={{ background:"rgba(255,255,255,0.032)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:18,padding:34,marginBottom:24 }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.55)",letterSpacing:"0.1em",textTransform:"uppercase",fontFamily:"'JetBrains Mono',monospace" }}>02 — Analysis Scope</div>
                  <span style={{ fontSize:12,color:"rgba(255,255,255,0.45)",fontFamily:"'JetBrains Mono',monospace" }}>{scopeList.length} selected</span>
                </div>
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}>
                  {ANALYSIS_SCOPES.map(scope => {
                    const sel = selectedScopes.has(scope.id);
                    return (
                      <div key={scope.id} className="scope-card" onClick={()=>toggleScope(scope.id)} style={{ display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderRadius:10,cursor:"pointer",
                        border: sel ? `1px solid ${scope.color}44` : "1px solid rgba(255,255,255,0.06)",
                        background: sel ? `${scope.color}10` : "rgba(255,255,255,0.02)" }}>
                        <div style={{ width:34,height:34,borderRadius:8,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,
                          background: sel ? `${scope.color}20` : "rgba(255,255,255,0.04)",
                          border: sel ? `1px solid ${scope.color}44` : "1px solid rgba(255,255,255,0.08)",
                          color: sel ? scope.color : "rgba(255,255,255,0.3)" }}>{scope.icon}</div>
                        <span style={{ fontSize:13,fontWeight:sel?600:400,color:sel?"rgba(255,255,255,0.92)":"rgba(255,255,255,0.48)",lineHeight:1.35 }}>{scope.label}</span>
                        {sel && <div style={{ marginLeft:"auto",width:20,height:20,borderRadius:"50%",background:scope.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:"#000",fontWeight:700 }}>✓</div>}
                      </div>
                    );
                  })}
                  {/* Custom scope cards */}
                  {customScopes.map(scope => (
                    <div key={scope.id} className="scope-card" style={{ display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderRadius:10,cursor:"default",
                      border:`1px solid ${scope.color}55`,background:`${scope.color}0e`,position:"relative" }}>
                      <div style={{ width:34,height:34,borderRadius:8,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,
                        background:`${scope.color}22`,border:`1px solid ${scope.color}55`,color:scope.color }}>{scope.icon}</div>
                      <span style={{ fontSize:13,fontWeight:600,color:"rgba(255,255,255,0.92)",lineHeight:1.3,flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{scope.label}</span>
                      <button onClick={()=>removeCustomScope(scope.id)}
                        style={{ flexShrink:0,width:18,height:18,borderRadius:"50%",border:"none",background:"rgba(255,255,255,0.1)",color:"rgba(255,255,255,0.5)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,lineHeight:1,padding:0,transition:"all 0.15s" }}
                        onMouseEnter={e=>{e.currentTarget.style.background="rgba(239,68,68,0.3)";e.currentTarget.style.color="#FCA5A5";}}
                        onMouseLeave={e=>{e.currentTarget.style.background="rgba(255,255,255,0.1)";e.currentTarget.style.color="rgba(255,255,255,0.5)";}}>✕</button>
                    </div>
                  ))}
                </div>
                {/* Add custom scope row */}
                <div style={{ marginTop:10 }}>
                  {showCustomInput ? (
                    <div style={{ display:"flex",gap:7,alignItems:"center" }}>
                      <input
                        autoFocus
                        value={customInputVal}
                        onChange={e=>setCustomInputVal(e.target.value)}
                        onKeyDown={e=>{if(e.key==="Enter")addCustomScope();if(e.key==="Escape"){setShowCustomInput(false);setCustomInputVal("");}}}
                        placeholder="e.g. Performance improvements, API changes…"
                        style={{ flex:1,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(0,212,255,0.4)",borderRadius:8,padding:"8px 13px",fontSize:12,color:"rgba(255,255,255,0.88)",fontFamily:"'JetBrains Mono',monospace",outline:"none",caretColor:"#00D4FF" }}
                      />
                      <button onClick={addCustomScope} disabled={!customInputVal.trim()}
                        style={{ padding:"8px 15px",borderRadius:8,border:"1px solid rgba(0,212,255,0.5)",background:"rgba(0,212,255,0.12)",color:"#00D4FF",fontSize:12,fontFamily:"'JetBrains Mono',monospace",fontWeight:600,cursor:customInputVal.trim()?"pointer":"default",opacity:customInputVal.trim()?1:0.4,transition:"all 0.15s" }}>
                        Add
                      </button>
                      <button onClick={()=>{setShowCustomInput(false);setCustomInputVal("");}}
                        style={{ padding:"8px 12px",borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"transparent",color:"rgba(255,255,255,0.35)",fontSize:12,cursor:"pointer" }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={()=>setShowCustomInput(true)}
                      style={{ display:"flex",alignItems:"center",gap:6,padding:"11px 16px",borderRadius:10,border:"1px dashed rgba(255,255,255,0.18)",background:"transparent",color:"rgba(255,255,255,0.38)",fontSize:13,fontFamily:"'JetBrains Mono',monospace",cursor:"pointer",transition:"all 0.15s",width:"100%" }}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor="rgba(0,212,255,0.4)";e.currentTarget.style.color="rgba(0,212,255,0.8)";e.currentTarget.style.background="rgba(0,212,255,0.04)";}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.15)";e.currentTarget.style.color="rgba(255,255,255,0.3)";e.currentTarget.style.background="transparent";}}>
                      <span style={{ fontSize:16,lineHeight:1,marginTop:-1 }}>+</span>
                      <span>Add custom scope</span>
                    </button>
                  )}
                </div>
              </div>

              {/* ── Step 03: Output Template ── */}
              <div style={{ background:"rgba(255,255,255,0.032)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:18,padding:34,marginBottom:24 }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.55)",letterSpacing:"0.1em",textTransform:"uppercase",fontFamily:"'JetBrains Mono',monospace" }}>03 — Output Template</div>
                  {templateLoading ? <span style={{ fontSize:10,color:"rgba(167,139,250,0.8)",fontFamily:"'JetBrains Mono',monospace" }}>⟳ Detecting styles…</span> : null}
                </div>
                <div style={{ display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:10 }}>
                  <button onClick={()=>setCustomTemplate(null)} style={{ padding:"7px 16px",borderRadius:8,cursor:"pointer",fontSize:12,fontFamily:"'JetBrains Mono',monospace",transition:"all 0.15s",
                    background:!customTemplate?"rgba(0,212,255,0.12)":"rgba(255,255,255,0.03)",
                    border:!customTemplate?"1px solid rgba(0,212,255,0.5)":"1px solid rgba(255,255,255,0.1)",
                    color:!customTemplate?"#00D4FF":"rgba(255,255,255,0.4)",fontWeight:!customTemplate?600:400}}>
                    {!customTemplate&&"✓ "}Default
                  </button>
                  {customTemplate ? (
                    <div style={{ display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,background:"rgba(167,139,250,0.12)",border:"1px solid rgba(167,139,250,0.5)" }}>
                      <span style={{ fontSize:12,fontFamily:"'JetBrains Mono',monospace",color:"#A78BFA",fontWeight:600 }}>✓ </span>
                      <span style={{ fontSize:12,fontFamily:"'JetBrains Mono',monospace",color:"#A78BFA",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{customTemplate.name}</span>
                      {customTemplate.styles ? <span style={{ fontSize:10,color:"rgba(167,139,250,0.5)",fontFamily:"'JetBrains Mono',monospace" }}> · styles mapped</span> : null}
                      <button onClick={()=>setCustomTemplate(null)} style={{ background:"none",border:"none",cursor:"pointer",color:"rgba(167,139,250,0.5)",fontSize:14,lineHeight:1,padding:"0 0 0 4px" }}>✕</button>
                    </div>
                  ) : (
                    <button onClick={()=>templateInputRef.current?.click()} disabled={templateLoading}
                      style={{ padding:"7px 16px",borderRadius:8,cursor:templateLoading?"wait":"pointer",fontSize:12,fontFamily:"'JetBrains Mono',monospace",
                        background:"rgba(167,139,250,0.06)",border:"1px dashed rgba(167,139,250,0.4)",color:"rgba(167,139,250,0.85)",transition:"all 0.15s"}}
                      onMouseEnter={handleUploadBtnEnter}
                      onMouseLeave={handleUploadBtnLeave}>
                      ＋ Upload custom .docx
                    </button>
                  )}
                  <input ref={templateInputRef} type="file" accept=".docx" style={{ display:"none" }}
                    onChange={handleTemplateUpload} />
                </div>
                <div style={{ fontSize:12,color:"rgba(255,255,255,0.38)",lineHeight:1.65 }}>
                  {customTemplate?"Your template styles have been detected and will be applied to the exported Word document.":"Uses the built-in corporate template. Upload your own .docx to apply your organisation's styles and branding."}
                </div>
              </div>

              <button className="btn-glow" onClick={()=>canRun&&setStep("confirm")} disabled={!canRun} style={{ width:"100%",padding:"18px",borderRadius:13,fontSize:15,fontWeight:700,letterSpacing:"0.06em",fontFamily:"'Syne',sans-serif",cursor:canRun?"pointer":"not-allowed",border:"none",
                background: canRun ? "linear-gradient(135deg,#00D4FF,#0055FF)" : "rgba(255,255,255,0.06)",
                color: canRun ? "#000" : "rgba(255,255,255,0.2)",
                boxShadow: canRun ? "0 4px 22px rgba(0,212,255,0.22)" : "none" }}>
                {canRun ? "→ CONFIGURE & ANALYZE" : "Select a document and at least one scope to continue"}
              </button>
            </div>
          )}

          {/* ════════════ CONFIRM ════════════ */}
          {step === "confirm" && (
            <div style={{ maxWidth:720,margin:"0 auto" }}>
              <div style={{ marginBottom:32 }}>
                <div style={{ fontSize:12,color:"rgba(255,255,255,0.45)",fontFamily:"'JetBrains Mono',monospace",marginBottom:10 }}>READY TO ANALYZE</div>
                <h2 style={{ fontFamily:"'Syne',sans-serif",fontSize:32,fontWeight:800,marginBottom:10 }}>Confirm Setup</h2>
                <p style={{ color:"rgba(255,255,255,0.56)",fontSize:15 }}>Claude will analyse your document for each selected scope module sequentially.</p>
              </div>
              <div style={{ background:"rgba(0,212,255,0.04)",border:"1px solid rgba(0,212,255,0.14)",borderRadius:13,padding:22,marginBottom:18 }}>
                <div style={{ fontSize:11,color:"#00D4FF",fontFamily:"'JetBrains Mono',monospace",marginBottom:12 }}>DOCUMENT</div>
                <div style={{ display:"flex",alignItems:"center",gap:12 }}>
                  <div style={{ width:42,height:42,borderRadius:9,background:"rgba(0,212,255,0.1)",border:"1px solid rgba(0,212,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20 }}>{docType==="pdf"?"📄":"🔗"}</div>
                  <div>
                    <div style={{ fontWeight:600,fontSize:14,color:"white",wordBreak:"break-all" }}>{fileName||urlInput}</div>
                    <div style={{ fontSize:11,color:"rgba(255,255,255,0.38)",fontFamily:"'JetBrains Mono',monospace",marginTop:2 }}>{docType==="pdf"?"PDF · ready for parsing":"URL · will fetch content"} · {selectedScopes.size} scope modules</div>
                  </div>
                </div>
              </div>
              <div style={{ background:"rgba(255,255,255,0.025)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:13,padding:22,marginBottom:24 }}>
                <div style={{ fontSize:11,color:"rgba(255,255,255,0.36)",fontFamily:"'JetBrains Mono',monospace",marginBottom:14 }}>SCOPE MODULES ({selectedScopes.size})</div>
                <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                  {scopeList.map(scope => (
                    <div key={scope.id} style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 14px",borderRadius:8,background:`${scope.color}08`,border:`1px solid ${scope.color}22` }}>
                      <span style={{ color:scope.color }}>{scope.icon}</span>
                      <span style={{ fontSize:13,color:"rgba(255,255,255,0.82)" }}>{scope.label}</span>
                      <span style={{ marginLeft:"auto",fontSize:10,color:scope.color,fontFamily:"'JetBrains Mono',monospace" }}>QUEUED</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display:"flex",gap:12 }}>
                <button onClick={()=>setStep("home")} style={{ flex:1,padding:"14px",borderRadius:10,cursor:"pointer",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",color:"rgba(255,255,255,0.55)",fontSize:13 }}>← Edit</button>
                <button className="btn-glow" onClick={runAnalysis} style={{ flex:2,padding:"14px",borderRadius:10,cursor:"pointer",background:"linear-gradient(135deg,#00D4FF,#0055FF)",border:"none",color:"#000",fontSize:14,fontWeight:700,fontFamily:"'Syne',sans-serif",letterSpacing:"0.05em",boxShadow:"0 4px 22px rgba(0,212,255,0.22)" }}>
                  ⟐ RUN AI ANALYSIS
                </button>
              </div>
            </div>
          )}

          {/* ════════════ ANALYZING ════════════ */}
          {step === "analyzing" && (
            <div style={{ maxWidth:640,margin:"60px auto" }}>
              {/* Spinner + phase */}
              <div style={{ textAlign:"center",marginBottom:40 }}>
                <div style={{ width:72,height:72,borderRadius:"50%",margin:"0 auto 24px",border:"2px solid rgba(0,212,255,0.1)",borderTop:"2px solid #00D4FF",animation:"spin 1s linear infinite" }} />
                <h2 style={{ fontFamily:"'Syne',sans-serif",fontSize:24,fontWeight:800,marginBottom:10 }}>Preparing Analysis</h2>
                <div style={{ fontSize:13,color:"#00D4FF",fontFamily:"'JetBrains Mono',monospace",minHeight:20 }}>{analysisPhase}</div>
              </div>
              {/* Overall progress bar */}
              <div style={{ marginBottom:32 }}>
                <div style={{ display:"flex",justifyContent:"space-between",marginBottom:8 }}>
                  <span style={{ fontSize:11,color:"rgba(255,255,255,0.4)",fontFamily:"'JetBrains Mono',monospace" }}>OVERALL PROGRESS</span>
                  <span style={{ fontSize:11,color:"#00D4FF",fontFamily:"'JetBrains Mono',monospace" }}>{analysisProgress}%</span>
                </div>
                <div style={{ background:"rgba(255,255,255,0.06)",borderRadius:100,height:8,overflow:"hidden" }}>
                  <div style={{ height:"100%",borderRadius:100,width:`${analysisProgress}%`,background:"linear-gradient(90deg,#0055FF,#00D4FF)",transition:"width 0.5s ease",boxShadow:"0 0 12px rgba(0,212,255,0.4)" }} />
                </div>
              </div>
              {/* Scope pipeline preview */}
              <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                {scopeList.map((scope,i) => (
                  <div key={scope.id} style={{ display:"flex",alignItems:"center",gap:12,padding:"10px 14px",borderRadius:9,
                    background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",
                    opacity: i === 0 ? 1 : 0.4, transition:"opacity 0.3s ease" }}>
                    <div style={{ width:28,height:28,borderRadius:6,background:`${scope.color}15`,border:`1px solid ${scope.color}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,color:scope.color }}>{scope.icon}</div>
                    <span style={{ fontSize:12,color:"rgba(255,255,255,0.6)",fontFamily:"'DM Sans',sans-serif" }}>{scope.label}</span>
                    <span style={{ marginLeft:"auto",fontSize:10,color:"rgba(255,255,255,0.2)",fontFamily:"'JetBrains Mono',monospace" }}>QUEUED</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ════════════ RESULTS ════════════ */}
          {step === "results" && (
            <div style={{ maxWidth:960,margin:"0 auto" }}>

              {/* ── STICKY PROGRESS PANEL ── */}
              {(streamingId || (analysisPhase && Object.values(resultMap).some(b=>b.length===0))) && (
                <div style={{ position:"sticky",top:0,zIndex:20,background:"rgba(7,11,20,0.95)",backdropFilter:"blur(16px)",borderBottom:"1px solid rgba(255,255,255,0.07)",padding:"16px 0 20px",marginBottom:24 }}>
                  {/* Title row */}
                  <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14 }}>
                    <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                      <div style={{ width:10,height:10,borderRadius:"50%",border:"2px solid rgba(0,212,255,0.2)",borderTop:"2px solid #00D4FF",animation:"spin 0.8s linear infinite" }} />
                      <span style={{ fontFamily:"'Syne',sans-serif",fontSize:15,fontWeight:800,color:"white" }}>
                        {streamingId
                          ? `Analysing scope ${currentScopeIdx+1} of ${scopeList.length}`
                          : `Preparing scope ${currentScopeIdx+2} of ${scopeList.length}…`}
                      </span>
                    </div>
                    <span style={{ fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:"'JetBrains Mono',monospace" }}>
                      {totalFindings} findings so far
                    </span>
                  </div>

                  {/* Overall progress bar */}
                  <div style={{ marginBottom:16 }}>
                    <div style={{ background:"rgba(255,255,255,0.06)",borderRadius:100,height:6,overflow:"hidden",position:"relative" }}>
                      <div style={{
                        height:"100%",borderRadius:100,
                        width:`${Math.round((Object.values(resultMap).filter(b=>b.length>0).length / Math.max(scopeList.length,1)) * 100)}%`,
                        background:"linear-gradient(90deg,#0055FF,#00D4FF)",
                        transition:"width 0.6s ease",
                        boxShadow:"0 0 10px rgba(0,212,255,0.5)",
                      }} />
                    </div>
                  </div>

                  {/* Scope pipeline — all modules visible with status */}
                  <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
                    {scopeList.map((scope, i) => {
                      const isDone      = (resultMap[scope.id]||[]).length > 0;
                      const isActive    = streamingId === scope.id;
                      const isPending   = !isDone && !isActive;
                      return (
                        <div key={scope.id} onClick={()=>isDone&&setActiveScopeId(scope.id)} style={{
                          display:"flex",alignItems:"center",gap:7,
                          padding:"7px 12px",borderRadius:8,
                          cursor: isDone ? "pointer" : "default",
                          transition:"all 0.3s ease",
                          background: isActive ? `${scope.color}18` : isDone ? `${scope.color}0C` : "rgba(255,255,255,0.02)",
                          border: isActive ? `1px solid ${scope.color}66` : isDone ? `1px solid ${scope.color}33` : "1px solid rgba(255,255,255,0.06)",
                        }}>
                          {/* Status icon */}
                          {isDone ? (
                            <span style={{ width:18,height:18,borderRadius:"50%",background:scope.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#000",fontWeight:800,flexShrink:0 }}>✓</span>
                          ) : isActive ? (
                            <span style={{ width:18,height:18,borderRadius:"50%",border:`2px solid ${scope.color}44`,borderTop:`2px solid ${scope.color}`,animation:"spin 0.8s linear infinite",display:"inline-block",flexShrink:0 }} />
                          ) : (
                            <span style={{ width:18,height:18,borderRadius:"50%",border:"1px solid rgba(255,255,255,0.12)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"rgba(255,255,255,0.2)",flexShrink:0 }}>{i+1}</span>
                          )}
                          {/* Label */}
                          <span style={{ fontSize:11,fontWeight:isActive?700:isDone?600:400,fontFamily:"'JetBrains Mono',monospace",
                            color: isActive ? scope.color : isDone ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.25)" }}>
                            {scope.icon} {scope.label}
                          </span>
                          {/* Count badge */}
                          {isDone && (
                            <span style={{ fontSize:10,color:scope.color,fontFamily:"'JetBrains Mono',monospace",fontWeight:700 }}>
                              {resultMap[scope.id].length}
                            </span>
                          )}
                          {isActive && (
                            <span style={{ display:"flex",gap:2 }}>
                              {[0,1,2].map(d=><span key={d} style={{ width:3,height:3,borderRadius:"50%",background:scope.color,display:"inline-block",animation:"bounce 1s ease infinite",animationDelay:`${d*0.15}s` }} />)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Phase label */}
                  {analysisPhase && (
                    <div style={{ marginTop:12,fontSize:11,color:"rgba(255,255,255,0.35)",fontFamily:"'JetBrains Mono',monospace" }}>
                      {analysisPhase}
                    </div>
                  )}
                </div>
              )}

              {/* ── COMPLETE HEADER (shown when done) ── */}
              {!streamingId && (
                <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24,flexWrap:"wrap",gap:12 }}>
                  <div>
                    <div style={{ fontSize:12,color:"rgba(255,255,255,0.45)",fontFamily:"'JetBrains Mono',monospace",marginBottom:8 }}>
                      ANALYSIS COMPLETE · {scopeList.length} MODULES
                    </div>
                    <h2 style={{ fontFamily:"'Syne',sans-serif",fontSize:28,fontWeight:800,marginBottom:6 }}>Release Analysis Report</h2>
                    <div style={{ fontSize:13,color:"rgba(255,255,255,0.52)",fontStyle:"italic" }}>{fileName||urlInput}</div>
                  </div>
                  <div style={{ display:"flex",alignItems:"center",gap:8,padding:"8px 16px",borderRadius:9,background:"rgba(52,211,153,0.07)",border:"1px solid rgba(52,211,153,0.22)" }}>
                    <PulsingDot color="#34D399" />
                    <span style={{ fontSize:12,fontFamily:"'JetBrains Mono',monospace",color:"#34D399" }}>
                      {totalFindings} FINDINGS READY
                    </span>
                  </div>
                </div>
              )}

              {/* ── SCOPE TABS ── */}
              <div style={{ display:"flex",gap:8,marginBottom:26,flexWrap:"wrap" }}>
                {scopeList.map(scope => {
                  const isActive   = activeScopeId === scope.id;
                  const isStreaming = streamingId === scope.id;
                  const isDone     = (resultMap[scope.id]||[]).length > 0;
                  return (
                    <button key={scope.id} className="tab-btn" onClick={()=>setActiveScopeId(scope.id)} style={{ padding:"9px 18px",borderRadius:9,cursor:"pointer",fontSize:12,fontFamily:"'JetBrains Mono',monospace",fontWeight:600,
                      border: isActive ? `1px solid ${scope.color}66` : "1px solid rgba(255,255,255,0.08)",
                      background: isActive ? `${scope.color}15` : "rgba(255,255,255,0.03)",
                      color: isActive ? scope.color : isDone ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.25)",
                      opacity: !isDone && !isStreaming && !isActive ? 0.45 : 1 }}>
                      {isStreaming ? <span style={{ animation:"shimmer 0.8s ease infinite" }}>⟳ </span> : isDone ? "✓ " : `${scope.icon} `}
                      {scope.label.split(" ")[0]}
                      {isDone && <span style={{ marginLeft:6,fontSize:9,color:scope.color }}>({resultMap[scope.id].length})</span>}
                    </button>
                  );
                })}
              </div>

              {/* ── ACTIVE SCOPE RESULT ── */}
              {activeScopeId && (() => {
                const scope     = ANALYSIS_SCOPES.find(s => s.id === activeScopeId);
                const bullets   = resultMap[activeScopeId] || [];
                const isStream  = streamingId === activeScopeId;
                return (
                  <div key={activeScopeId} style={{ background:"rgba(255,255,255,0.018)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:14,padding:28,animation:"fadeSlide 0.35s ease",marginBottom:18 }}>
                    <StreamingBlock scope={scope} bullets={bullets} isStreaming={isStream} />
                    {!isStream && bullets.length === 0 && (
                      <div style={{ color:"rgba(255,255,255,0.26)",fontSize:12,fontFamily:"'JetBrains Mono',monospace",padding:"8px 0" }}>
                        ⏳ Pending — will be analysed shortly…
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ═══ Export Panel ═══ */}
              <div style={{ border:"1px solid rgba(255,255,255,0.10)",borderRadius:12,overflow:"hidden" }}>
                {/* Template indicator — change on home screen */}
                <div style={{ padding:"10px 20px",background:"rgba(255,255,255,0.02)",borderBottom:"1px solid rgba(255,255,255,0.07)",display:"flex",alignItems:"center",gap:10 }}>
                  <span style={{ fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:"rgba(255,255,255,0.28)",letterSpacing:"0.08em" }}>TEMPLATE</span>
                  <span style={{ fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:customTemplate?"#A78BFA":"rgba(0,212,255,0.7)" }}>
                    {customTemplate ? `📎 ${customTemplate.name}` : "✦ Default"}
                  </span>
                  {customTemplate && customTemplate.styles ? <span style={{ fontSize:10,color:"rgba(255,255,255,0.2)",fontFamily:"'JetBrains Mono',monospace" }}> · styles mapped</span> : null}
                </div>
                {/* ── Bottom: export action buttons ── */}
                <div style={{ padding:"12px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10 }}>
                  <div style={{ fontSize:11,color:"rgba(255,255,255,0.22)",fontFamily:"'JetBrains Mono',monospace",flexShrink:0 }}>
                    {totalFindings} findings · {scopeList.length} modules · {fileName||urlInput||""}
                  </div>
                  <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
                    <button className="exp-btn" onClick={handleCopyText} style={{ padding:"8px 16px",borderRadius:7,cursor:"pointer",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.12)",color:"rgba(255,255,255,0.55)",fontSize:11,fontFamily:"'JetBrains Mono',monospace" }}>
                      📋 Copy Text
                    </button>
                    <button className="exp-btn"
                      onClick={()=>exportToTxt(scopeList,resultMap,fileName||urlInput,totalFindings,docTitle)}
                      style={{ padding:"8px 16px",borderRadius:7,cursor:"pointer",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.12)",color:"rgba(255,255,255,0.55)",fontSize:11,fontFamily:"'JetBrains Mono',monospace" }}>
                      📄 Export .TXT
                    </button>
                    <button className="exp-btn"
                      onClick={handleWordExport}
                      style={{ padding:"8px 16px",borderRadius:7,cursor:"pointer",background:"linear-gradient(135deg,rgba(0,180,255,0.15),rgba(0,80,255,0.15))",border:"1px solid rgba(0,212,255,0.35)",color:"#00D4FF",fontSize:11,fontFamily:"'JetBrains Mono',monospace",fontWeight:600 }}>
                      📘 Export Word (.docx)
                    </button>
                  </div>
                </div>

              </div>
            </div>
          )}

        </div>
      </div>

      {!API_KEY && (
        <div style={{ position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)", background:"#140d00", border:"1px solid rgba(251,191,36,0.4)", borderRadius:10, padding:"12px 20px", zIndex:999, display:"flex", alignItems:"center", gap:10, maxWidth:560, boxShadow:"0 8px 32px rgba(0,0,0,0.5)" }}>
          <span style={{ fontSize:16 }}>⚠️</span>
          <span style={{ color:"rgba(255,255,255,0.75)", fontSize:13 }}>No API key detected. Set VITE_ANTHROPIC_API_KEY in your .env file and rebuild.</span>
        </div>
      )}
      {error && <ErrorBanner msg={error} onClose={()=>setError(null)} />}
    </div>
  );
}
