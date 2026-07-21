import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/parsers/index';

describe('parseDocument', () => {
  describe('text files', () => {
    it('parses plain text', async () => {
      const buf = new TextEncoder().encode('Hello, world!');
      const result = await parseDocument(buf, 'txt', 'test.txt');
      expect(result.text).toBe('Hello, world!');
      expect(result.mimeType).toBe('text/plain');
      expect(result.metadata.fileName).toBe('test.txt');
    });

    it('parses markdown files', async () => {
      const buf = new TextEncoder().encode('# Title\n\nContent');
      const result = await parseDocument(buf, 'md', 'test.md');
      expect(result.text).toBe('# Title\n\nContent');
      expect(result.mimeType).toBe('text/plain');
    });

    it('parses JSON files', async () => {
      const buf = new TextEncoder().encode('{"key": "value"}');
      const result = await parseDocument(buf, 'json', 'test.json');
      expect(result.text).toBe('{"key": "value"}');
    });
  });

  describe('HTML files', () => {
    it('extracts plain text from HTML', async () => {
      const html = '<html><head><title>Test Page</title></head><body><h1>Title</h1><p>Paragraph text.</p></body></html>';
      const buf = new TextEncoder().encode(html);
      const result = await parseDocument(buf, 'html', 'test.html');
      expect(result.text).toContain('Title');
      expect(result.text).toContain('Paragraph text');
      expect(result.mimeType).toBe('text/html');
    });

    it('removes script and style content', async () => {
      const html = '<html><body><p>Hello</p><script>alert("xss")</script><style>.cls{}</style></body></html>';
      const buf = new TextEncoder().encode(html);
      const result = await parseDocument(buf, 'html', 'test.html');
      expect(result.text).not.toContain('alert');
      expect(result.text).not.toContain('.cls');
      expect(result.text).toContain('Hello');
    });

    it('extracts title from HTML', async () => {
      const html = '<html><head><title>My Document</title></head><body><p>Content</p></body></html>';
      const buf = new TextEncoder().encode(html);
      const result = await parseDocument(buf, 'htm', 'test.htm');
      expect(result.metadata.title).toBe('My Document');
    });

    it('resolves HTML entities', async () => {
      const html = '<p>AT&amp;T &lt; 10 &gt; 5 &quot;quote&quot;</p>';
      const buf = new TextEncoder().encode(html);
      const result = await parseDocument(buf, 'html', 'test.html');
      expect(result.text).toContain('AT&T');
      expect(result.text).toContain('< 10 > 5');
    });
  });

  describe('stub parsers', () => {
    it('returns a stub message for PDF', async () => {
      const buf = new Uint8Array(0);
      const result = await parseDocument(buf, 'pdf', 'doc.pdf');
      expect(result.text).toContain('PDF');
      expect(result.mimeType).toBe('application/pdf');
    });

    it('returns a stub message for DOCX', async () => {
      const buf = new Uint8Array(0);
      const result = await parseDocument(buf, 'docx', 'doc.docx');
      expect(result.text).toContain('DOCX');
      expect(result.mimeType).toContain('wordprocessing');
    });

    it('returns a stub message for XLSX', async () => {
      const buf = new Uint8Array(0);
      const result = await parseDocument(buf, 'xlsx', 'data.xlsx');
      expect(result.text).toContain('XLSX');
      expect(result.mimeType).toContain('spreadsheet');
    });
  });

  describe('case insensitivity', () => {
    it('handles uppercase extensions', async () => {
      const buf = new TextEncoder().encode('hello');
      const result = await parseDocument(buf, 'TXT', 'test.TXT');
      expect(result.text).toBe('hello');
    });

    it('handles mixed case HTML', async () => {
      const buf = new TextEncoder().encode('<p>Hello</p>');
      const result = await parseDocument(buf, 'HTML', 'test.HTML');
      expect(result.text).toContain('Hello');
    });
  });
});