import { describe, expect, it } from 'vitest';
import { firstUrl, parseMarkdownLite } from '@/lib/markdown-lite';

describe('parseMarkdownLite', () => {
  it('passes plain text through untouched', () => {
    expect(parseMarkdownLite('hello room')).toEqual([
      { text: 'hello room', bold: false, italic: false, code: false, link: false },
    ]);
  });

  it('parses bold, italic and code', () => {
    const spans = parseMarkdownLite('a **bold** b *ital* c `code` d');
    expect(spans.filter((s) => s.bold).map((s) => s.text)).toEqual(['bold']);
    expect(spans.filter((s) => s.italic).map((s) => s.text)).toEqual(['ital']);
    expect(spans.filter((s) => s.code).map((s) => s.text)).toEqual(['code']);
    expect(spans.map((s) => s.text).join('')).toBe('a bold b ital c code d');
  });

  it('marks bare URLs as links', () => {
    const spans = parseMarkdownLite('watch https://example.com/x now');
    const link = spans.find((s) => s.link);
    expect(link?.text).toBe('https://example.com/x');
  });

  it('does not treat a single asterisk pair across newlines as italic', () => {
    const spans = parseMarkdownLite('a *b\nc* d');
    expect(spans.every((s) => !s.italic)).toBe(true);
  });
});

describe('firstUrl', () => {
  it('finds the first URL in a draft', () => {
    expect(firstUrl('look at https://a.b/c please')).toBe('https://a.b/c');
    expect(firstUrl('no links')).toBeNull();
  });
});
