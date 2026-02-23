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
  { id: 1, title: "Dell DAP 1.x Deployment Guide",    date: "Feb 2026", scopes: ["New & Changed Features", "Deprecated Features", "Deployment Changes"] },
  { id: 2, title: "VMware vSphere 8.0 Release Notes", date: "Jan 2026", scopes: ["Breaking Changes", "Security & Compliance"] },
  { id: 3, title: "Kubernetes 1.30 Migration Guide",  date: "Dec 2025", scopes: ["Migration Guide", "Deprecated Features"] },
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
    .map(l => l.replace(/^[\s\-•*\d.)\]]+/, "").trim())
    .filter(l => l.length > 10);
}

function deduplicateBullets(bullets) {
  const seen = [];
  const out  = [];
  for (const b of bullets) {
    const key = b.toLowerCase().replace(/\s+/g, " ").slice(0, 60);
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

// Load docx library — uses npm bundle (no CDN needed)
async function loadDocxLib() {
  return import("docx");
}

// Generate and download a business-style Word document matching the reference report style
async function exportToDocx(scopeList, resultMap, docName, totalFindings, docTitle = {}) {
  const lib = await loadDocxLib();
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    AlignmentType, BorderStyle, WidthType, ShadingType,
    LevelFormat, Footer, Header, TabStopType, VerticalAlign
  } = lib;

  const now    = new Date();
  const dateStr = now.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });

  // Use AI-extracted title if available, otherwise fall back to filename
  const sourceLabel    = docTitle?.title    || docName || "Vendor Documentation";
  const sourceSubtitle = docTitle?.subtitle || "Release Analysis & Change Summary";
  const sourceRevision = docTitle?.revision || "";

  // ── Exact colours from reference document ─────────────────────────────────
  const NAVY  = "003366";  // H1, bold header text
  const BLUE  = "0066CC";  // H2, subtitle, table headers
  const DGREY = "444444";  // body text
  const GREY  = "666666";  // footer, italic meta text
  const ROW0  = "F5F8FC";  // alternating table row (even)
  const WHITE = "FFFFFF";
  const W     = 9360;      // content width DXA (US Letter, 0.75" margins)

  const hex = c => c.replace(/^#/, "").slice(0, 6).toUpperCase().padEnd(6, "0");

  // ── Text run builder ───────────────────────────────────────────────────────
  const T = (text, opts = {}) => new TextRun({
    text,
    font:    "Calibri",
    size:    opts.size   || 20,
    bold:    !!opts.bold,
    italics: !!opts.italic,
    color:   hex(opts.color || DGREY),
  });

  // ── Paragraph builder ──────────────────────────────────────────────────────
  const P = (runs, opts = {}) => new Paragraph({
    alignment: opts.align || AlignmentType.LEFT,
    spacing:   opts.spacing || { before: 60, after: 60 },
    border:    opts.border,
    numbering: opts.num,
    children:  Array.isArray(runs) ? runs : (runs ? [runs] : []),
  });

  const spacer = (b, a) => P([], { spacing: { before: b || 0, after: a || 160 } });

  // ── H1: Large navy bold, bottom border — matches reference exactly ─────────
  const H1 = (num, text) => P(
    T(`${num}.  ${text}`, { size: 28, bold: true, color: NAVY }),
    {
      spacing: { before: 400, after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: hex(NAVY), space: 4 } },
    }
  );

  // ── H2: Blue bold — matches reference exactly ─────────────────────────────
  const H2 = (num, sub, text) => P(
    T(`${num}.${sub}  ${text}`, { size: 22, bold: true, color: BLUE }),
    { spacing: { before: 280, after: 80 } }
  );

  // ── Body paragraph ─────────────────────────────────────────────────────────
  const body = (text, opts = {}) => P(
    T(text, { size: 20, color: opts.color || DGREY, italic: opts.italic }),
    { spacing: { before: opts.before || 60, after: opts.after || 60 } }
  );

  // ── Bullet — using docx numbering (not unicode) ───────────────────────────
  const bul = (text) => P(
    T(text, { size: 20, color: DGREY }),
    { num: { reference: "bullets", level: 0 }, spacing: { before: 40, after: 40 } }
  );

  // ── Thin blue rule (section separator) ───────────────────────────────────
  const rule = () => P([], {
    spacing: { before: 160, after: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: hex(BLUE), space: 1 } },
  });

  // ── Table helpers ──────────────────────────────────────────────────────────
  const TBorder = { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" };
  const TBorders = { top: TBorder, bottom: TBorder, left: TBorder, right: TBorder };

  const TCell = (children, w, fill) => new TableCell({
    borders:  TBorders,
    shading:  fill ? { fill: hex(fill), type: ShadingType.CLEAR } : undefined,
    width:    { size: w, type: WidthType.DXA },
    margins:  { top: 100, bottom: 100, left: 140, right: 140 },
    verticalAlign: VerticalAlign.TOP,
    children: Array.isArray(children) ? children : [children],
  });

  const HdrCell = (text, w) => TCell(
    P(T(text, { size: 19, bold: true, color: WHITE })),
    w, BLUE
  );

  const DataCell = (text, w, even, opts = {}) => TCell(
    P(T(text, { size: 19, color: opts.color || DGREY, bold: opts.bold, italic: opts.italic }), { align: opts.align }),
    w, even ? ROW0 : WHITE
  );

  // ── SCOPE LABEL → SECTION NUMBER MAP ──────────────────────────────────────
  const SCOPE_IDS = {
    "New & Changed Features":  "new_features",
    "Deprecated Features":     "deprecated",
    "Deployment Changes":      "deployment_changes",
    "Security & Compliance":   "security",
    "Breaking Changes":        "breaking_changes",
    "Migration Guide":         "migration_guide",
  };

  // Section titles matching reference naming convention
  const SECTION_TITLES = {
    new_features:       "New or Changed Features",
    deprecated:         "Deprecated or Removed Features",
    deployment_changes: "Deployment Guide Update Notes",
    security:           "Security & Compliance Requirements",
    breaking_changes:   "Breaking Changes",
    migration_guide:    "Migration Action Plan",
  };

  // Context sentence per scope (matches reference prose style)
  const SECTION_INTRO = {
    new_features:       `The following features and sections were added or significantly updated in this release compared to the previous version.`,
    deprecated:         `The following items have been removed or superseded in this release.`,
    deployment_changes: `The following items represent notable changes that impact how deployments should be executed.`,
    security:           `The following security requirements and compliance changes were identified in this release.`,
    breaking_changes:   `The following changes will break existing deployments or integrations without remediation. Immediate review is required before upgrading.`,
    migration_guide:    `The following actions are required when upgrading from the previous release. Complete each step in sequence.`,
  };

  // ── TITLE BLOCK (no cover page — matches reference exactly) ──────────────
  // Large centered title, blue subtitle, revision line, italic tagline, thin blue rule
  const titleBlock = [
    P(T(sourceLabel, { size: 48, bold: true, color: NAVY }),
      { align: AlignmentType.CENTER, spacing: { before: 0, after: 80 } }),
    P(T(sourceSubtitle, { size: 26, bold: true, color: BLUE }),
      { align: AlignmentType.CENTER, spacing: { before: 0, after: 80 } }),
    ...(sourceRevision ? [
      P(T(`Document Revision: ${sourceRevision}`, { size: 20, color: DGREY }),
        { align: AlignmentType.CENTER, spacing: { before: 0, after: 40 } }),
    ] : [
      P(T(`Generated: ${dateStr}`, { size: 20, color: DGREY }),
        { align: AlignmentType.CENTER, spacing: { before: 0, after: 40 } }),
    ]),
    P(T("Prepared by ReleaseLens — for internal review and deployment planning", { size: 18, italic: true, color: GREY }),
      { align: AlignmentType.CENTER, spacing: { before: 0, after: 360 } }),
    rule(),
    spacer(0, 0),
  ];

  // ── SCOPE SECTION BUILDERS (each matching reference layout per scope type) ─

  // NEW FEATURES: H2 sub-section per finding with body text + bullets
  // Matches reference style: 1.1 Title (New), paragraph, bullets
  const buildNewFeatures = (secNum, bullets) => {
    if (!bullets.length) return [body("No new or changed features identified in this release.", { italic: true, color: GREY })];
    return bullets.flatMap((b, i) => {
      // Findings are now formatted as "Short Title (New/Updated): Full detail sentence"
      // per the system prompt. Extract title = before first colon, detail = after.
      let title, detail;
      const colonIdx = b.indexOf(":");
      if (colonIdx > 5 && colonIdx < 80) {
        title  = b.slice(0, colonIdx).trim();
        detail = b.slice(colonIdx + 1).trim();
      } else {
        // Fallback: use first em-dash split or truncate
        const dashPos = b.search(/\s[—–]\s/);
        title  = dashPos > 10 ? b.slice(0, dashPos).trim() : b.slice(0, 60).trim();
        detail = dashPos > 10 ? b.slice(dashPos).replace(/^\s*[—–]\s*/, "") : "";
      }
      return [
        H2(secNum, i + 1, title),
        body(detail),
        spacer(0, 80),
      ];
    });
  };

  // DEPLOYMENT CHANGES: 3-col table — Changed Section | Nature of Change | Operational Impact
  // Matches reference Section 3 exactly
  const buildDeployment = (secNum, bullets) => {
    if (!bullets.length) return [body("No deployment changes identified in this release.", { italic: true, color: GREY })];
    return [
      new Table({
        width: { size: W, type: WidthType.DXA },
        columnWidths: [3600, 1800, 3960],
        rows: [
          new TableRow({ children: [
            HdrCell("Changed Section", 3600),
            HdrCell("Nature of Change", 1800),
            HdrCell("Operational Impact", 3960),
          ]}),
          ...bullets.map((b, i) => {
          // Parse "Section Name — Nature of Change — Operational Impact" format
            const parts = b.split(/\s+[—–-]{1,2}\s+/);
            const sectionName = parts[0] ? parts[0].trim() : b.slice(0, 50);
            const nature = parts[1] ? parts[1].trim()
              : /new section/i.test(b) ? "New section added"
              : /fully replaced/i.test(b) ? "Fully replaced"
              : /removed/i.test(b) ? "Removed"
              : "Updated";
            const impact = parts[2] ? parts[2].trim() : "Review and update runbooks accordingly.";
            return new TableRow({ children: [
              DataCell(sectionName, 3600, i % 2 === 0),
              DataCell(nature, 1800, i % 2 === 0),
              DataCell(impact, 3960, i % 2 === 0, { italic: true, color: GREY }),
            ]});
          }),
        ],
      }),
    ];
  };

  // DEPRECATED: 3-col table — Item | Status | Notes
  // Matches reference Section 4 exactly
  const buildDeprecated = (secNum, bullets) => {
    if (!bullets.length) return [body("No deprecated or removed items identified in this release.", { italic: true, color: GREY })];
    return [
      new Table({
        width: { size: W, type: WidthType.DXA },
        columnWidths: [2880, 1800, 4680],
        rows: [
          new TableRow({ children: [
            HdrCell("Item", 2880),
            HdrCell("Status", 1800),
            HdrCell("Notes", 4680),
          ]}),
          ...bullets.map((b) => {
            const parts = b.split(/\s+[—–]\s+/);
            const itemName = parts[0] ? parts[0].trim() : b.slice(0, 50);
            const notes    = parts.slice(1).join(" — ").trim() || b;
            const status = /prohibit/i.test(b) ? "Prohibited"
              : /replac|supersed/i.test(b) ? "Replaced"
              : /merg/i.test(b) ? "Merged/Superseded"
              : /remov/i.test(b) ? "Removed"
              : "Deprecated";
            return new TableRow({ children: [
              DataCell(itemName, 2880, false),
              DataCell(status, 1800, false),
              DataCell(notes, 4680, false),
            ]});
          }),
        ],
      }),
    ];
  };

  // SECURITY: 3-col table — Requirement | Severity | Verified
  const buildSecurity = (secNum, bullets) => {
    if (!bullets.length) return [body("No security findings identified in this release.", { italic: true, color: GREY })];
    return [
      new Table({
        width: { size: W, type: WidthType.DXA },
        columnWidths: [6120, 1440, 1800],
        rows: [
          new TableRow({ children: [
            HdrCell("Security Requirement", 6120),
            HdrCell("Severity", 1440),
            HdrCell("Verified", 1800),
          ]}),
          ...bullets.map((b, i) => {
            const sev = /must|never|cannot|critical|prohibit/i.test(b) ? "Critical"
              : /required|mandatory/i.test(b) ? "High" : "Medium";
            const sevColor = sev === "Critical" ? "C00000" : sev === "High" ? "C55A11" : "1D6833";
            return new TableRow({ children: [
              DataCell(b, 6120, i % 2 === 0),
              DataCell(sev, 1440, i % 2 === 0, { bold: true, color: sevColor, align: AlignmentType.CENTER }),
              DataCell("☐", 1800, false, { align: AlignmentType.CENTER }),
            ]});
          }),
        ],
      }),
    ];
  };

  // BREAKING CHANGES: 3-col table — Change | Impact | Action Required
  const buildBreaking = (secNum, bullets) => {
    if (!bullets.length) return [body("No breaking changes identified in this release.", { italic: true, color: GREY })];
    return [
      body("⚠  All breaking changes require immediate review before upgrading any environment.", { color: "C00000", before: 0, after: 120 }),
      new Table({
        width: { size: W, type: WidthType.DXA },
        columnWidths: [5040, 1440, 2880],
        rows: [
          new TableRow({ children: [
            HdrCell("Breaking Change", 5040),
            HdrCell("Impact", 1440),
            HdrCell("Action Required", 2880),
          ]}),
          ...bullets.map((b, i) => {
            const impact = /remov|no longer|replac/i.test(b) ? "Breaking" : "High";
            return new TableRow({ children: [
              DataCell(b, 5040, i % 2 === 0),
              DataCell(impact, 1440, false, { bold: true, color: "C00000", align: AlignmentType.CENTER }),
              DataCell("Review and remediate before upgrade.", 2880, i % 2 === 0, { italic: true, color: GREY }),
            ]});
          }),
        ],
      }),
    ];
  };

  // MIGRATION GUIDE: 3-col table — Area | Action Required | Priority
  // Matches reference Section 6 "Key Actions for Deployment Teams" exactly
  const buildMigration = (secNum, bullets) => {
    if (!bullets.length) return [body("No migration steps identified in this release.", { italic: true, color: GREY })];
    return [
      new Table({
        width: { size: W, type: WidthType.DXA },
        columnWidths: [3240, 4680, 1440],
        rows: [
          new TableRow({ children: [
            HdrCell("Area", 3240),
            HdrCell("Action Required", 4680),
            HdrCell("Priority", 1440),
          ]}),
          ...bullets.map((b, i) => {
            // Prompt produces "Area — Action description — Priority"
            const mparts = b.split(/\s+[—–]\s+/);
            const area   = mparts[0] ? mparts[0].trim() : b.slice(0, 30);
            const action = mparts[1] ? mparts[1].trim() : b;
            const priRaw = mparts[2] ? mparts[2].trim() : "";
            const pri = /critical/i.test(priRaw) || /critical|must|cannot|never/i.test(b) ? "Critical"
              : /high/i.test(priRaw) || /required|before|ensure/i.test(b) ? "High"
              : "Medium";
            const priColor = pri === "Critical" ? "C00000" : pri === "High" ? "C55A11" : "1D6833";
            return new TableRow({ children: [
              DataCell(area, 3240, i % 2 === 0, { bold: true }),
              DataCell(action, 4680, i % 2 === 0),
              DataCell(pri, 1440, i % 2 === 0, { bold: true, color: priColor, align: AlignmentType.CENTER }),
            ]});
          }),
        ],
      }),
    ];
  };

  const buildSection = (scope, bullets, secNum) => {
    const id = SCOPE_IDS[scope.label] || "default";
    if (id === "new_features")       return buildNewFeatures(secNum, bullets);
    if (id === "deployment_changes") return buildDeployment(secNum, bullets);
    if (id === "deprecated")         return buildDeprecated(secNum, bullets);
    if (id === "security")           return buildSecurity(secNum, bullets);
    if (id === "breaking_changes")   return buildBreaking(secNum, bullets);
    if (id === "migration_guide")    return buildMigration(secNum, bullets);
    // Fallback: plain bullets
    if (!bullets.length) return [body("No findings identified for this scope.", { italic: true, color: GREY })];
    return bullets.map(b => bul(b));
  };

  // ── ASSEMBLE ALL CONTENT ───────────────────────────────────────────────────
  const children = [...titleBlock];

  scopeList.forEach((scope, idx) => {
    const secNum = idx + 1;
    const id     = SCOPE_IDS[scope.label] || "default";
    const title  = SECTION_TITLES[id] || scope.label;
    const intro  = SECTION_INTRO[id]  || "";
    const bullets = resultMap[scope.id] || [];

    children.push(
      H1(secNum, title),
      body(intro, { before: 60, after: 240 }),
      spacer(0, 60),
      ...buildSection(scope, bullets, secNum),
    );

    if (idx < scopeList.length - 1) {
      children.push(rule(), spacer(0, 0));
    }
  });

  // End of document line — matches reference italic centered line
  children.push(
    rule(),
    P(T(`End of Document — ${sourceLabel}  (${dateStr})`, { size: 18, italic: true, color: GREY }),
      { align: AlignmentType.CENTER, spacing: { before: 120, after: 120 } }),
  );

  // ── HEADER — bold navy doc title left, grey date right, bottom rule ────────
  const header = new Header({
    children: [new Paragraph({
      spacing: { before: 0, after: 0 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: hex(NAVY), space: 4 } },
      tabStops: [{ type: TabStopType.RIGHT, position: W }],
      children: [
        new TextRun({ text: `${sourceLabel} — ${sourceSubtitle}`, font: "Calibri", size: 19, bold: true, color: hex(NAVY) }),
        new TextRun({ text: `\t${dateStr}`, font: "Calibri", size: 18, color: hex(GREY) }),
      ],
    })],
  });

  // ── FOOTER — "Confidential — Internal Use" left, "Page" right, top rule ───
  const footer = new Footer({
    children: [new Paragraph({
      spacing: { before: 0, after: 0 },
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC", space: 4 } },
      tabStops: [{ type: TabStopType.RIGHT, position: W }],
      children: [
        new TextRun({ text: "Confidential — Internal Use", font: "Calibri", size: 18, color: hex(GREY) }),
        new TextRun({ text: "\tPage", font: "Calibri", size: 18, color: hex(GREY) }),
      ],
    })],
  });

  // ── DOCUMENT ───────────────────────────────────────────────────────────────
  const doc = new Document({
    numbering: {
      config: [{
        reference: "bullets",
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: "\u2022",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 560, hanging: 280 } } },
        }],
      }],
    },
    styles: {
      default: { document: { run: { font: "Calibri", size: 20, color: hex(DGREY) } } },
    },
    sections: [{
      properties: {
        page: {
          size:   { width: 12240, height: 15840 },
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
        },
      },
      headers: { default: header },
      footers: { default: footer },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `ReleaseLens_${(sourceLabel || "analysis").replace(/[^a-z0-9]/gi, "_").slice(0, 40)}_${now.toISOString().slice(0, 10)}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}



// Generate and download a rich plain-text report
function exportToTxt(scopeList, resultMap, docName, totalFindings) {
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
  a.download = `ReleaseLens_${(docName || "analysis").replace(/[^a-z0-9]/gi, "_").slice(0, 40)}_${now.toISOString().slice(0,10)}.txt`;
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
  const fileInputRef        = useRef(null);
  const abortRef            = useRef(null);

  const scopeList = [...selectedScopes]
    .map(id => ANALYSIS_SCOPES.find(s => s.id === id))
    .filter(Boolean);

  const canRun = (file || urlInput.trim()) && selectedScopes.size > 0;

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
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (parsed.title) return parsed;
    } catch (e) { /* silent — fall back to filename */ }
    return null;
  };

    const callClaudeWithText = async (scopeId, textContent, signal) => {
    const systemPrompt = `You are a senior technical release analyst specialising in vendor documentation.
Extract precise, actionable findings from vendor documentation.
Respond ONLY with a numbered list (one finding per line, starting with number and period).
Each finding: one complete sentence, 15-45 words, specific and technical.
No headers, no preamble, no summary - only numbered findings.
Scope: ${SCOPE_PROMPTS[scopeId]}`;

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
        .hist:hover{background:rgba(255,255,255,0.04)!important}
        .hist{transition:background 0.15s ease}
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
      <div style={{ position:"relative",zIndex:10,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"13px 28px",borderBottom:"1px solid rgba(255,255,255,0.06)",background:"rgba(7,11,20,0.85)",backdropFilter:"blur(20px)" }}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <div style={{ width:34,height:34,borderRadius:9,background:"linear-gradient(135deg,#00D4FF,#0055FF)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:"#000",fontWeight:800 }}>⟐</div>
          <div>
            <div style={{ fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,letterSpacing:"-0.02em" }}>Release<span style={{ color:"#00D4FF" }}>Lens</span></div>
            <div style={{ fontSize:10,color:"rgba(255,255,255,0.3)",letterSpacing:"0.1em",textTransform:"uppercase",fontFamily:"'JetBrains Mono',monospace" }}>AI Release Analysis Platform</div>
          </div>
        </div>
        <div style={{ display:"flex",alignItems:"center",gap:20 }}>
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
        <div style={{ width:228,flexShrink:0,borderRight:"1px solid rgba(255,255,255,0.055)",background:"rgba(255,255,255,0.012)",display:"flex",flexDirection:"column" }}>
          <div style={{ padding:"20px 14px",overflow:"auto",flex:1 }}>
            <div style={{ fontSize:10,color:"rgba(255,255,255,0.28)",letterSpacing:"0.15em",textTransform:"uppercase",fontFamily:"'JetBrains Mono',monospace",marginBottom:14 }}>Recent Analyses</div>
            {SAMPLE_HISTORY.map(h => (
              <div key={h.id} className="hist" style={{ padding:"10px",borderRadius:9,marginBottom:6,cursor:"pointer" }}>
                <div style={{ fontSize:12,fontWeight:600,color:"rgba(255,255,255,0.82)",marginBottom:3,lineHeight:1.35 }}>{h.title}</div>
                <div style={{ fontSize:10,color:"rgba(255,255,255,0.3)",fontFamily:"'JetBrains Mono',monospace",marginBottom:7 }}>{h.date}</div>
                <div style={{ display:"flex",flexWrap:"wrap",gap:4 }}>
                  {h.scopes.slice(0,2).map(s => <span key={s} style={{ fontSize:9,padding:"2px 7px",borderRadius:4,background:"rgba(0,212,255,0.08)",color:"#00D4FF",fontFamily:"'JetBrains Mono',monospace" }}>{s.split(" ")[0]}</span>)}
                  {h.scopes.length>2 && <span style={{ fontSize:9,color:"rgba(255,255,255,0.3)" }}>+{h.scopes.length-2}</span>}
                </div>
              </div>
            ))}
            <div style={{ marginTop:24,padding:"14px 12px",borderRadius:10,background:"rgba(0,212,255,0.04)",border:"1px solid rgba(0,212,255,0.1)" }}>
              <div style={{ fontSize:10,color:"#00D4FF",fontFamily:"'JetBrains Mono',monospace",marginBottom:6 }}>📊 Session</div>
              <div style={{ fontSize:24,fontWeight:700,fontFamily:"'Syne',sans-serif",color:"white" }}>{totalFindings}</div>
              <div style={{ fontSize:10,color:"rgba(255,255,255,0.38)",marginTop:2 }}>findings extracted</div>
            </div>
          </div>
        </div>

        {/* ── MAIN CONTENT ── */}
        <div style={{ flex:1,overflow:"auto",padding:"32px 40px" }}>

          {/* ════════════ HOME ════════════ */}
          {step === "home" && (
            <div style={{ maxWidth:680,margin:"0 auto" }}>
              <div style={{ textAlign:"center",marginBottom:48 }}>
                <div style={{ display:"inline-flex",alignItems:"center",gap:8,background:"rgba(0,212,255,0.08)",border:"1px solid rgba(0,212,255,0.2)",borderRadius:100,padding:"5px 16px",marginBottom:22 }}>
                  <PulsingDot color="#00D4FF" />
                  <span style={{ fontSize:11,color:"#00D4FF",fontFamily:"'JetBrains Mono',monospace",letterSpacing:"0.1em" }}>POWERED BY CLAUDE AI</span>
                </div>
                <h1 style={{ fontFamily:"'Syne',sans-serif",fontSize:44,fontWeight:800,lineHeight:1.1,letterSpacing:"-0.03em",marginBottom:14, background:"linear-gradient(135deg,#fff 0%,rgba(255,255,255,0.62) 100%)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent" }}>
                  Vendor Release<br/>
                  <span style={{ background:"linear-gradient(135deg,#00D4FF,#0055FF)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent" }}>Intelligence</span>
                </h1>
                <p style={{ color:"rgba(255,255,255,0.44)",fontSize:15,lineHeight:1.75,maxWidth:460,margin:"0 auto" }}>
                  Upload vendor documentation or paste a URL. Choose your analysis scope. Get structured, AI-generated release intelligence in seconds.
                </p>
              </div>

              {/* Step 1: Document */}
              <div style={{ background:"rgba(255,255,255,0.028)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:16,padding:28,marginBottom:18 }}>
                <div style={{ fontSize:11,fontWeight:600,color:"rgba(255,255,255,0.38)",letterSpacing:"0.1em",textTransform:"uppercase",fontFamily:"'JetBrains Mono',monospace",marginBottom:16 }}>01 — Document Source</div>
                <div style={{ display:"flex",gap:8,marginBottom:18 }}>
                  {["pdf","url"].map(t => (
                    <button key={t} onClick={()=>setDocType(t)} style={{ padding:"7px 20px",borderRadius:8,cursor:"pointer",fontFamily:"'JetBrains Mono',monospace",fontSize:11,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",transition:"all 0.15s ease",
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
                    style={{ border:"2px dashed rgba(0,212,255,0.2)",borderRadius:12,padding:"32px 20px",textAlign:"center",cursor:"pointer",background:fileName?"rgba(0,212,255,0.04)":"transparent",transition:"all 0.2s ease" }}
                    onMouseEnter={e=>e.currentTarget.style.borderColor="rgba(0,212,255,0.45)"}
                    onMouseLeave={e=>e.currentTarget.style.borderColor="rgba(0,212,255,0.2)"}
                  >
                    <input ref={fileInputRef} type="file" accept=".pdf" onChange={e=>{const f=e.target.files[0];if(f){setFile(f);setFileName(f.name);}}} />
                    {fileName ? (
                      <><div style={{ fontSize:28,marginBottom:8 }}>📄</div><div style={{ color:"#00D4FF",fontSize:14,fontWeight:600,marginBottom:4 }}>{fileName}</div><div style={{ color:"rgba(255,255,255,0.3)",fontSize:11 }}>Click to change file</div></>
                    ) : (
                      <><div style={{ fontSize:30,marginBottom:10,animation:"float 3s ease-in-out infinite" }}>⬆</div><div style={{ color:"rgba(255,255,255,0.6)",fontSize:13,marginBottom:4 }}>Click to upload PDF</div><div style={{ color:"rgba(255,255,255,0.28)",fontSize:11 }}>Deployment guides, release notes, changelogs</div></>
                    )}
                  </div>
                ) : (
                  <input
                    value={urlInput}
                    onChange={e=>setUrlInput(e.target.value)}
                    placeholder="https://docs.vendor.com/release-notes/v2-5…"
                    style={{ width:"100%",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,padding:"13px 16px",color:"white",fontSize:13,fontFamily:"'JetBrains Mono',monospace",transition:"border-color 0.2s ease" }}
                    onFocus={e=>e.target.style.borderColor="rgba(0,212,255,0.5)"}
                    onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}
                  />
                )}
              </div>

              {/* Step 2: Scope */}
              <div style={{ background:"rgba(255,255,255,0.028)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:16,padding:28,marginBottom:22 }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
                  <div style={{ fontSize:11,fontWeight:600,color:"rgba(255,255,255,0.38)",letterSpacing:"0.1em",textTransform:"uppercase",fontFamily:"'JetBrains Mono',monospace" }}>02 — Analysis Scope</div>
                  <span style={{ fontSize:11,color:"rgba(255,255,255,0.28)" }}>{selectedScopes.size} selected</span>
                </div>
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
                  {ANALYSIS_SCOPES.map(scope => {
                    const sel = selectedScopes.has(scope.id);
                    return (
                      <div key={scope.id} className="scope-card" onClick={()=>toggleScope(scope.id)} style={{ display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:9,cursor:"pointer",
                        border: sel ? `1px solid ${scope.color}44` : "1px solid rgba(255,255,255,0.06)",
                        background: sel ? `${scope.color}10` : "rgba(255,255,255,0.02)" }}>
                        <div style={{ width:28,height:28,borderRadius:6,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,
                          background: sel ? `${scope.color}20` : "rgba(255,255,255,0.04)",
                          border: sel ? `1px solid ${scope.color}44` : "1px solid rgba(255,255,255,0.08)",
                          color: sel ? scope.color : "rgba(255,255,255,0.3)" }}>{scope.icon}</div>
                        <span style={{ fontSize:12,fontWeight:sel?600:400,color:sel?"rgba(255,255,255,0.9)":"rgba(255,255,255,0.4)",lineHeight:1.35 }}>{scope.label}</span>
                        {sel && <div style={{ marginLeft:"auto",width:16,height:16,borderRadius:"50%",background:scope.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#000",fontWeight:700 }}>✓</div>}
                      </div>
                    );
                  })}
                </div>
              </div>

              <button className="btn-glow" onClick={()=>canRun&&setStep("confirm")} disabled={!canRun} style={{ width:"100%",padding:"16px",borderRadius:11,fontSize:14,fontWeight:700,letterSpacing:"0.05em",fontFamily:"'Syne',sans-serif",cursor:canRun?"pointer":"not-allowed",border:"none",
                background: canRun ? "linear-gradient(135deg,#00D4FF,#0055FF)" : "rgba(255,255,255,0.06)",
                color: canRun ? "#000" : "rgba(255,255,255,0.2)",
                boxShadow: canRun ? "0 4px 22px rgba(0,212,255,0.22)" : "none" }}>
                {canRun ? "→ CONFIGURE & ANALYZE" : "Select a document and at least one scope to continue"}
              </button>
            </div>
          )}

          {/* ════════════ CONFIRM ════════════ */}
          {step === "confirm" && (
            <div style={{ maxWidth:640,margin:"0 auto" }}>
              <div style={{ marginBottom:32 }}>
                <div style={{ fontSize:11,color:"rgba(255,255,255,0.28)",fontFamily:"'JetBrains Mono',monospace",marginBottom:8 }}>READY TO ANALYZE</div>
                <h2 style={{ fontFamily:"'Syne',sans-serif",fontSize:28,fontWeight:800,marginBottom:8 }}>Confirm Setup</h2>
                <p style={{ color:"rgba(255,255,255,0.42)",fontSize:14 }}>Claude will analyse your document for each selected scope module sequentially.</p>
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
            <div style={{ maxWidth:560,margin:"60px auto" }}>
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
            <div style={{ maxWidth:840,margin:"0 auto" }}>

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
                    <div style={{ fontSize:11,color:"rgba(255,255,255,0.28)",fontFamily:"'JetBrains Mono',monospace",marginBottom:6 }}>
                      ANALYSIS COMPLETE · {scopeList.length} MODULES
                    </div>
                    <h2 style={{ fontFamily:"'Syne',sans-serif",fontSize:24,fontWeight:800,marginBottom:4 }}>Release Analysis Report</h2>
                    <div style={{ fontSize:12,color:"rgba(255,255,255,0.38)",fontStyle:"italic" }}>{fileName||urlInput}</div>
                  </div>
                  <div style={{ display:"flex",alignItems:"center",gap:8,padding:"8px 16px",borderRadius:9,background:"rgba(52,211,153,0.07)",border:"1px solid rgba(52,211,153,0.22)" }}>
                    <PulsingDot color="#34D399" />
                    <span style={{ fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"#34D399" }}>
                      {totalFindings} FINDINGS READY
                    </span>
                  </div>
                </div>
              )}

              {/* ── SCOPE TABS ── */}
              <div style={{ display:"flex",gap:6,marginBottom:22,flexWrap:"wrap" }}>
                {scopeList.map(scope => {
                  const isActive   = activeScopeId === scope.id;
                  const isStreaming = streamingId === scope.id;
                  const isDone     = (resultMap[scope.id]||[]).length > 0;
                  return (
                    <button key={scope.id} className="tab-btn" onClick={()=>setActiveScopeId(scope.id)} style={{ padding:"7px 14px",borderRadius:8,cursor:"pointer",fontSize:11,fontFamily:"'JetBrains Mono',monospace",fontWeight:600,
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

              {/* Export bar */}
              <div style={{ padding:"16px 20px",background:"rgba(255,255,255,0.018)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12 }}>
                <div>
                  <div style={{ fontSize:13,color:"rgba(255,255,255,0.7)",fontWeight:600,marginBottom:3 }}>
                    {totalFindings} findings · {scopeList.length} modules
                  </div>
                  <div style={{ fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:"'JetBrains Mono',monospace" }}>
                    {fileName||urlInput||"Analysis complete"}
                  </div>
                </div>
                <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
                  <button className="exp-btn" onClick={()=>{
                    const text = scopeList.map(s=>`## ${s.label}\n${(resultMap[s.id]||[]).map((b,i)=>`${i+1}. ${b}`).join("\n")}`).join("\n\n");
                    navigator.clipboard.writeText(text).then(()=>alert("Copied to clipboard!"));
                  }} style={{ padding:"8px 16px",borderRadius:7,cursor:"pointer",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.12)",color:"rgba(255,255,255,0.6)",fontSize:11,fontFamily:"'JetBrains Mono',monospace" }}>
                    📋 Copy Text
                  </button>
                  <button className="exp-btn" onClick={()=>exportToTxt(scopeList,resultMap,fileName||urlInput,totalFindings,docTitle)}
                    style={{ padding:"8px 16px",borderRadius:7,cursor:"pointer",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.12)",color:"rgba(255,255,255,0.6)",fontSize:11,fontFamily:"'JetBrains Mono',monospace" }}>
                    📄 Export .TXT
                  </button>
                  <button className="exp-btn"
                    onClick={async()=>{
                      try{
                        await exportToDocx(scopeList,resultMap,fileName||urlInput,totalFindings,docTitle);
                      }catch(e){
                        alert("Export failed: "+e.message);
                      }
                    }}
                    style={{ padding:"8px 16px",borderRadius:7,cursor:"pointer",background:"linear-gradient(135deg,rgba(0,180,255,0.15),rgba(0,80,255,0.15))",border:"1px solid rgba(0,212,255,0.35)",color:"#00D4FF",fontSize:11,fontFamily:"'JetBrains Mono',monospace",fontWeight:600 }}>
                    📘 Export Word (.docx)
                  </button>
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
