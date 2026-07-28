import { describe, expect, it } from 'vitest';
import { extractToolCalls } from '../src/tool-utils';

describe('extractToolCalls', () => {
  it('extracts a tool call with JSON args using funcName({...}) syntax', () => {
    const text = 'I will call the tool: get_weather({"city": "Beijing"})';
    const calls = extractToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('get_weather');
    expect(calls[0]!.args).toEqual({ city: 'Beijing' });
  });

  it('extracts multiple tool calls', () => {
    const text = 'tool1({"a":1})\ntool2({"b":2})';
    const calls = extractToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.name).toBe('tool1');
    expect(calls[1]!.name).toBe('tool2');
  });

  it('returns empty array when no tool calls', () => {
    const text = 'This is a regular response without any tool calls.';
    const calls = extractToolCalls(text);
    expect(calls).toEqual([]);
  });

  it('handles empty text', () => {
    expect(extractToolCalls('')).toEqual([]);
  });

  it('handles malformed JSON args gracefully', () => {
    const text = 'test({"broken": )';
    const calls = extractToolCalls(text);
    expect(calls).toHaveLength(0);
  });

  it('handles namespaced tool call', () => {
    const text = 'namespace:func({"x": 1})';
    const calls = extractToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('namespace:func');
    expect(calls[0]!.args).toEqual({ x: 1 });
  });

  it('handles tool call with empty args object', () => {
    const text = 'ping({})';
    const calls = extractToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('ping');
    expect(calls[0]!.args).toEqual({});
  });

  it('handles tool call with number and boolean values', () => {
    const text = 'search({"query": "test", "limit": 10, "enabled": true})';
    const calls = extractToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('search');
  });
});
