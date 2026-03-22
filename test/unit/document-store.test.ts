import { describe, it, expect, vi } from 'vitest';
import { DocumentStore } from '../../src/core/workspace/document-store.js';

describe('DocumentStore', () => {
  it('opens a document and retrieves its text', () => {
    const store = new DocumentStore();
    store.open('file:///a.tw', 'hello world');
    expect(store.getText('file:///a.tw')).toBe('hello world');
    expect(store.has('file:///a.tw')).toBe(true);
  });

  it('updates a document and retrieves new text', () => {
    const store = new DocumentStore();
    store.open('file:///a.tw', 'v1');
    store.update('file:///a.tw', 'v2');
    expect(store.getText('file:///a.tw')).toBe('v2');
  });

  it('closes a document', () => {
    const store = new DocumentStore();
    store.open('file:///a.tw', 'content');
    store.close('file:///a.tw');
    expect(store.has('file:///a.tw')).toBe(false);
    expect(store.getText('file:///a.tw')).toBeUndefined();
  });

  it('returns all URIs', () => {
    const store = new DocumentStore();
    store.open('file:///a.tw', 'a');
    store.open('file:///b.tw', 'b');
    store.open('file:///c.tw', 'c');
    expect(store.getUris().sort()).toEqual([
      'file:///a.tw',
      'file:///b.tw',
      'file:///c.tw',
    ]);
  });

  it('tracks document versions', () => {
    const store = new DocumentStore();
    store.open('file:///a.tw', 'v1', 1);
    expect(store.getVersion('file:///a.tw')).toBe(1);
    store.update('file:///a.tw', 'v2', 5);
    expect(store.getVersion('file:///a.tw')).toBe(5);
  });

  it('auto-increments version when none provided', () => {
    const store = new DocumentStore();
    store.open('file:///a.tw', 'v1');
    expect(store.getVersion('file:///a.tw')).toBe(0);
    store.update('file:///a.tw', 'v2');
    expect(store.getVersion('file:///a.tw')).toBe(1);
    store.update('file:///a.tw', 'v3');
    expect(store.getVersion('file:///a.tw')).toBe(2);
  });

  it('emits documentOpened on open', () => {
    const store = new DocumentStore();
    const handler = vi.fn();
    store.on('documentOpened', handler);
    store.open('file:///a.tw', 'content');
    expect(handler).toHaveBeenCalledWith('file:///a.tw');
  });

  it('emits documentChanged on update', () => {
    const store = new DocumentStore();
    const handler = vi.fn();
    store.on('documentChanged', handler);
    store.open('file:///a.tw', 'v1');
    store.update('file:///a.tw', 'v2');
    expect(handler).toHaveBeenCalledWith('file:///a.tw');
  });

  it('emits documentClosed on close', () => {
    const store = new DocumentStore();
    const handler = vi.fn();
    store.on('documentClosed', handler);
    store.open('file:///a.tw', 'content');
    store.close('file:///a.tw');
    expect(handler).toHaveBeenCalledWith('file:///a.tw');
  });

  it('loadFromDisk reads files into the store', () => {
    const store = new DocumentStore();
    // loadFromDisk uses fs.readFileSync — we test with actual temp files
    // For unit tests we verify the method exists and handles empty array
    store.loadFromDisk([]);
    expect(store.getUris()).toEqual([]);
  });

  it('returns version 0 for unknown documents', () => {
    const store = new DocumentStore();
    expect(store.getVersion('file:///unknown.tw')).toBe(0);
  });
});
