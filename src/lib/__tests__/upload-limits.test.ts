import { describe, expect, it } from 'vitest';
import {
  RECEIPT_MAX_FILE_SIZE,
  RECEIPT_SCREEN_RULES,
  formatSizeLimit,
  screenFile,
  screenFiles,
  type ScreenableFile,
} from '../upload-limits';

const file = (name: string, type: string, size = 1_024): ScreenableFile => ({ name, type, size });

describe('screenFile', () => {
  it('accepts the mime types the receipt intake pipeline stores', () => {
    expect(screenFile(file('bill.pdf', 'application/pdf'), RECEIPT_SCREEN_RULES)).toBeNull();
    expect(screenFile(file('bill.jpg', 'image/jpeg'), RECEIPT_SCREEN_RULES)).toBeNull();
    expect(screenFile(file('bill.png', 'image/png'), RECEIPT_SCREEN_RULES)).toBeNull();
  });

  it('rejects a type the server would reject anyway', () => {
    expect(screenFile(file('bill.docx', 'application/msword'), RECEIPT_SCREEN_RULES))
      .toBe('unsupported file type');
  });

  it('rejects files over the shared size cap, quoting the same number', () => {
    const oversized = file('bill.pdf', 'application/pdf', RECEIPT_MAX_FILE_SIZE + 1);
    expect(screenFile(oversized, RECEIPT_SCREEN_RULES)).toBe('exceeds 10MB limit');
    expect(formatSizeLimit(RECEIPT_MAX_FILE_SIZE)).toBe('10MB');
  });

  it('accepts a file exactly at the cap', () => {
    const atCap = file('bill.pdf', 'application/pdf', RECEIPT_MAX_FILE_SIZE);
    expect(screenFile(atCap, RECEIPT_SCREEN_RULES)).toBeNull();
  });

  it('rejects empty files', () => {
    expect(screenFile(file('bill.pdf', 'application/pdf', 0), RECEIPT_SCREEN_RULES)).toBe('file is empty');
  });

  it('falls back to the extension when the drag source reports no mime type', () => {
    expect(screenFile(file('bill.pdf', ''), RECEIPT_SCREEN_RULES)).toBeNull();
    expect(screenFile(file('bill.exe', ''), RECEIPT_SCREEN_RULES)).toBe('unsupported file type');
  });

  it('defers to the server when neither type nor extension is known', () => {
    expect(screenFile(file('scan', ''), RECEIPT_SCREEN_RULES)).toBeNull();
  });

  it('accepts an allowed extension even when the mime type is unrecognised', () => {
    expect(screenFile(file('bill.pdf', 'application/octet-stream'), RECEIPT_SCREEN_RULES)).toBeNull();
  });
});

describe('screenFiles', () => {
  it('keeps the good files in a mixed batch and reports each rejection', () => {
    const batch = [
      file('january.pdf', 'application/pdf'),
      file('notes.txt', 'text/plain'),
      file('february.png', 'image/png'),
      file('huge.pdf', 'application/pdf', RECEIPT_MAX_FILE_SIZE + 1),
    ];

    const { accepted, rejected } = screenFiles(batch, RECEIPT_SCREEN_RULES);

    expect(accepted.map(entry => entry.name)).toEqual(['january.pdf', 'february.png']);
    expect(rejected).toEqual([
      { file: batch[1], reason: 'unsupported file type' },
      { file: batch[3], reason: 'exceeds 10MB limit' },
    ]);
  });

  it('handles an empty drop without throwing', () => {
    expect(screenFiles([], RECEIPT_SCREEN_RULES)).toEqual({ accepted: [], rejected: [] });
  });
});
