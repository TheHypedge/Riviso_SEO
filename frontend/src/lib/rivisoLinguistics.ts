/**
 * RIVISO linguistic analysis (client mirror of backend riviso_linguistics.py).
 */

export type IntegritySignal = { label: string; detail: string; excerpt?: string };
export type IntegrityFlag = {
  index: number;
  text: string;
  reason: string;
  signals?: IntegritySignal[];
};

const SENT_SPLIT = /(?<=[.!?])\s+/;
const WS = /\s+/;
const HEADING_RE = /^#{1,6}\s/;

const HUMAN_AVG_SENT = 23.2;
const AI_AVG_SENT = 29.2;
const HUMAN_VERY_LONG = 6.2;
const AI_VERY_LONG = 17.0;
const HUMAN_VERY_SHORT = 5.8;
const HUMAN_LONG_WORD = 23.1;
const AI_LONG_WORD = 30.7;
const HUMAN_MEAN_WORD = 5.24;
const AI_MEAN_WORD = 5.86;
const HUMAN_FUNCTION = 0.4;

const VERY_LONG = 40;
const VERY_SHORT = 8;
const LONG_CHARS = 8;

const FUNCTION_WORDS = new Set(
  `a an the and or but if while because although though as at by for from in into of on onto to with without within over under about after before between through during is are was were be been being am have has had do does did will would could should may might must can shall that which who whom whose this these those it its they them their we our you your he she his her not no nor so than then also just only even still yet already`.split(
    " ",
  ),
);

const AI_MARKERS = [
  "delve",
  "moreover",
  "furthermore",
  "additionally",
  "it is important to note",
  "plays a crucial role",
  "comprehensive guide",
  "navigate the complexities",
  "emerging trends",
  "key legal takeaways",
  "conceptual overview",
  "staying informed",
  "ensuring protection",
];

export function splitMarkdownParagraphs(md: string): string[] {
  const raw = (md || "").replace(/\r\n/g, "\n");
  const blocks: string[] = [];
  let buf: string[] = [];

  const flushBuf = () => {
    const joined = buf.join("\n").trim();
    buf = [];
    if (joined) blocks.push(joined);
  };

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (HEADING_RE.test(t)) {
      flushBuf();
      blocks.push(t);
    } else if (!t) {
      flushBuf();
    } else {
      buf.push(line);
    }
  }
  flushBuf();

  const expanded: string[] = [];
  for (const block of blocks) {
    const words = block.split(/\s+/).filter(Boolean);
    if (words.length > 180) {
      const sentences = block.split(SENT_SPLIT).map((s) => s.trim()).filter(Boolean);
      let chunk: string[] = [];
      let chunkWords = 0;
      for (const sent of sentences) {
        const w = sent.split(/\s+/).filter(Boolean).length;
        if (chunkWords + w > 90 && chunk.length) {
          expanded.push(chunk.join(" "));
          chunk = [];
          chunkWords = 0;
        }
        chunk.push(sent);
        chunkWords += w;
      }
      if (chunk.length) expanded.push(chunk.join(" "));
    } else {
      expanded.push(block);
    }
  }
  return expanded.filter((b) => b.trim());
}

function tokens(text: string): string[] {
  return (text || "").toLowerCase().split(/[^\w']+/).filter(Boolean);
}

function splitSentences(text: string): string[] {
  const s = (text || "").replace(WS, " ").trim();
  if (!s) return [];
  return s.split(SENT_SPLIT).map((x) => x.trim()).filter(Boolean);
}

function burstiness(sentLens: number[]): number {
  if (sentLens.length < 2) return 0;
  const mean = sentLens.reduce((a, b) => a + b, 0) / sentLens.length;
  if (mean <= 0) return 0;
  const variance = sentLens.reduce((a, x) => a + (x - mean) ** 2, 0) / (sentLens.length - 1);
  const stdev = Math.sqrt(Math.max(0, variance));
  return Math.max(0, Math.min(1, stdev / mean / 0.32));
}

export function computeLinguisticMetrics(text: string): Record<string, number> {
  const sents = splitSentences(text);
  const words = tokens(text);
  const wc = words.length || 1;
  let longW = 0;
  let charSum = 0;
  let funcW = 0;
  for (const w of words) {
    if (w.length >= LONG_CHARS) longW += 1;
    charSum += w.length;
    if (FUNCTION_WORDS.has(w)) funcW += 1;
  }
  const sentLens = sents.map((s) => tokens(s).length).filter((n) => n > 0);
  const nSent = sentLens.length || 1;
  const avgSent = sentLens.length ? sentLens.reduce((a, b) => a + b, 0) / sentLens.length : 0;
  const veryLong = sentLens.filter((n) => n > VERY_LONG).length;
  const veryShort = sentLens.filter((n) => n <= VERY_SHORT).length;

  return {
    avg_sentence_length: Math.round(avgSent * 100) / 100,
    very_long_sentence_pct: Math.round((100 * veryLong) / nSent * 100) / 100,
    very_short_sentence_pct: Math.round((100 * veryShort) / nSent * 100) / 100,
    long_word_pct: Math.round((100 * longW) / wc * 100) / 100,
    mean_word_length: Math.round((charSum / wc) * 100) / 100,
    function_word_ratio: Math.round((funcW / wc) * 1000) / 1000,
    burstiness: Math.round(burstiness(sentLens) * 1000) / 1000,
    sentence_count: sentLens.length,
    word_count: wc,
  };
}

function band(val: number, human: number, ai: number): number {
  if (ai === human) return 0;
  return Math.max(0, Math.min(1, (val - human) / (ai - human)));
}

function aiProfileDistance(m: Record<string, number>): number {
  const parts = [
    band(m.avg_sentence_length, HUMAN_AVG_SENT, AI_AVG_SENT),
    band(m.very_long_sentence_pct, HUMAN_VERY_LONG, AI_VERY_LONG),
    Math.min(1, Math.max(0, HUMAN_VERY_SHORT - m.very_short_sentence_pct) / HUMAN_VERY_SHORT),
    band(m.long_word_pct, HUMAN_LONG_WORD, AI_LONG_WORD),
    band(m.mean_word_length, HUMAN_MEAN_WORD, AI_MEAN_WORD),
    Math.min(1, Math.max(0, HUMAN_FUNCTION - m.function_word_ratio) / 0.15),
    Math.max(0, 1 - m.burstiness),
  ];
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function markerHits(text: string): string[] {
  const low = text.toLowerCase();
  return AI_MARKERS.filter((m) => low.includes(m));
}

export function analyzeParagraphSignals(text: string): { score: number; signals: IntegritySignal[] } {
  const metrics = computeLinguisticMetrics(text);
  let score = aiProfileDistance(metrics);
  const signals: IntegritySignal[] = [];
  const sents = splitSentences(text);

  if (metrics.avg_sentence_length >= 27) {
    signals.push({
      label: "Sentence length",
      detail: `Average sentence length ~${metrics.avg_sentence_length} words vs typical human ~${HUMAN_AVG_SENT}.`,
      excerpt: (sents[0] || text).slice(0, 160),
    });
  }
  if (metrics.very_long_sentence_pct >= 12) {
    const longSent = sents.find((s) => tokens(s).length > VERY_LONG) || sents[0] || "";
    signals.push({
      label: "Very long sentences",
      detail: `Very long sentences (${metrics.very_long_sentence_pct}% vs human ~${HUMAN_VERY_LONG}%).`,
      excerpt: longSent.slice(0, 160),
    });
  }
  if (metrics.very_short_sentence_pct < 3.5 && metrics.sentence_count >= 3) {
    signals.push({
      label: "Few short sentences",
      detail: `Few punchy sentences ≤${VERY_SHORT} words (${metrics.very_short_sentence_pct}% vs human ~${HUMAN_VERY_SHORT}%).`,
      excerpt: (sents[sents.length - 1] || "").slice(0, 160),
    });
  }
  const hits = markerHits(text);
  if (hits.length) {
    signals.push({
      label: "AI signal phrasing",
      detail: `Templated phrasing: ${hits.slice(0, 4).join(", ")}.`,
      excerpt: text.slice(0, 160),
    });
  }
  if (metrics.long_word_pct >= 28) {
    signals.push({
      label: "Long-word density",
      detail: `Long words (8+ chars) at ${metrics.long_word_pct}% vs human ~${HUMAN_LONG_WORD}%.`,
      excerpt: text.slice(0, 160),
    });
  }
  if (metrics.mean_word_length >= 5.6) {
    signals.push({
      label: "Mean word length",
      detail: `Mean word length ~${metrics.mean_word_length} chars vs human ~${HUMAN_MEAN_WORD}.`,
      excerpt: text.slice(0, 160),
    });
  }
  if (metrics.function_word_ratio < 0.36) {
    signals.push({
      label: "Function-word ratio",
      detail: `Low function-word ratio ~${Math.round(metrics.function_word_ratio * 100)}% vs human ~${HUMAN_FUNCTION * 100}%.`,
      excerpt: text.slice(0, 160),
    });
  }
  if (metrics.burstiness < 0.28) {
    signals.push({
      label: "Low burstiness",
      detail: "Uniform sentence rhythm (low burstiness).",
      excerpt: (sents[0] || "").slice(0, 160),
    });
  }
  if (/^conceptual overview|^key legal takeaways|^emerging trends/i.test(text.trim())) {
    signals.push({
      label: "AI-style heading",
      detail: "Formal header-like phrasing typical of templated AI outlines.",
      excerpt: text.trim().slice(0, 160),
    });
    score = Math.max(score, 0.55);
  }

  return { score, signals };
}

export type AuditResult = {
  ai_percentage: number;
  flagged_paragraphs: IntegrityFlag[];
  metrics: Record<string, number>;
};

export function auditMarkdown(md: string, threshold = 0.48): AuditResult {
  const paras = splitMarkdownParagraphs(md);
  if (!paras.length) {
    return { ai_percentage: 0, flagged_paragraphs: [], metrics: { burstiness: 0, predictability: 0 } };
  }

  const flags: IntegrityFlag[] = [];
  let totalWords = 0;
  let flaggedWords = 0;
  const paraScores: number[] = [];

  for (let i = 0; i < paras.length; i += 1) {
    const p = paras[i];
    const wc = p.split(/\s+/).filter(Boolean).length;
    totalWords += wc;
    const { score, signals } = analyzeParagraphSignals(p);
    paraScores.push(score);
    const isHeading = HEADING_RE.test(p.trim());
    const shouldFlag = wc >= 8 && (score >= threshold || (isHeading && score >= 0.52) || signals.length >= 3);

    if (shouldFlag) {
      flaggedWords += wc;
      const reasonParts = signals.slice(0, 3).map((s) => s.detail);
      flags.push({
        index: i,
        text: p,
        reason: reasonParts.length ? reasonParts.join(" ") : "Elevated AI-style linguistic profile.",
        signals,
      });
    }
  }

  const docMetrics = computeLinguisticMetrics(paras.join("\n\n"));
  const docPred = paraScores.reduce((a, b) => a + b, 0) / paraScores.length;
  const wordPct = totalWords > 0 ? (flaggedWords / totalWords) * 100 : docPred * 100;

  return {
    ai_percentage: Math.round(Math.max(0, Math.min(100, wordPct)) * 10) / 10,
    flagged_paragraphs: flags,
    metrics: {
      burstiness: docMetrics.burstiness,
      predictability: Math.round(docPred * 1000) / 1000,
      paragraphs: paras.length,
      flagged: flags.length,
      avg_sentence_length: docMetrics.avg_sentence_length,
      long_word_pct: docMetrics.long_word_pct,
      function_word_ratio: docMetrics.function_word_ratio,
    },
  };
}
