/**
 * markdown-lite (bold / italic / code / links) — chat message renderer.
 * Pure; ported from apps/mobile Chat.tsx so web + mobile render identically.
 */

export interface Span {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  link: boolean;
}

const TOKEN_RE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|https?:\/\/[^\s]+)/g;

export function parseMarkdownLite(body: string): Span[] {
  const spans: Span[] = [];
  const plain = (text: string): void => {
    if (text.length > 0) {
      spans.push({ text, bold: false, italic: false, code: false, link: false });
    }
  };
  let last = 0;
  for (const m of body.matchAll(TOKEN_RE)) {
    const idx = m.index;
    plain(body.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith('**')) {
      spans.push({ text: tok.slice(2, -2), bold: true, italic: false, code: false, link: false });
    } else if (tok.startsWith('*')) {
      spans.push({ text: tok.slice(1, -1), bold: false, italic: true, code: false, link: false });
    } else if (tok.startsWith('`')) {
      spans.push({ text: tok.slice(1, -1), bold: false, italic: false, code: true, link: false });
    } else {
      spans.push({ text: tok, bold: false, italic: false, code: false, link: true });
    }
    last = idx + tok.length;
  }
  plain(body.slice(last));
  return spans;
}

/** First URL in a message body/draft, if any (used for the unfurl preview). */
export function firstUrl(text: string): string | null {
  const m = /https?:\/\/[^\s]+/.exec(text);
  return m === null ? null : m[0];
}
