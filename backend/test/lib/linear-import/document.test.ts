import { describe, expect, test } from 'vitest';
import { parseDocument } from '../../../../tooling/linear-import/document.ts';

// Parsing the Markdown copy of a Linear document. Made-up test text only.

const COPY = `# Test document specification

Copy from Linear, saved on 2026-10-01.

- Linear ID: 00000000-1111-4222-8333-444444444444
- Project in Linear: Test project
- Created: 2026-09-01T08:00:00.000Z · Updated: 2026-09-02T09:30:00.500Z · by Test Person
- URL: https://linear.app/test/document/test-document-abc123

---

Status: test text.

## Section

- Item [Link](https://example.org)
`;

const PARSED = {
  linearId: '00000000-1111-4222-8333-444444444444',
  title: 'Test document specification',
  projectName: 'Test project',
  createdAt: Date.parse('2026-09-01T08:00:00.000Z'),
  updatedAt: Date.parse('2026-09-02T09:30:00.500Z'),
  url: 'https://linear.app/test/document/test-document-abc123',
  markdown: 'Status: test text.\n\n## Section\n\n- Item [Link](https://example.org)\n',
};

describe('parseDocument', () => {
  test('title, Linear ID, project, timestamps, source, text after the separator', () => {
    expect(parseDocument(COPY)).toEqual(PARSED);
  });

  test('accepts the German header labels of older copies', () => {
    const german = COPY.replace('- Linear ID:', '- Linear-ID:')
      .replace('- Project in Linear:', '- Projekt in Linear:')
      .replace('- Created:', '- Angelegt:')
      .replace('· Updated:', '· Geändert:');
    expect(parseDocument(german)).toEqual(PARSED);
  });

  test('an unknown layout throws instead of guessing', () => {
    expect(() => parseDocument(COPY.replace('# Test document', 'Test document'))).toThrow(/heading/);
    expect(() => parseDocument(COPY.replace('\n---\n', '\n'))).toThrow(/separator/);
    expect(() => parseDocument(COPY.replace('00000000-1111', 'broken'))).toThrow(/Linear ID/);
    expect(() => parseDocument(COPY.replace('2026-09-02T09:30:00.500Z', 'yesterday'))).toThrow(/Updated/);
    expect(() => parseDocument(COPY.replace('https://linear.app/test', 'https://example.org'))).toThrow(/Linear URL/);
  });
});
