import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from '@mariozechner/pi-agent-core';
import { describe, expect, test } from 'vitest';
import { AgentSession } from './agent-session';

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text } as unknown as AgentMessage;
}

describe('AgentSession', () => {
  test('construction works with no options', () => {
    const session = new AgentSession();
    const state = session.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.messageCount).toBe(0);
    expect(state.model).toBeUndefined();
  });

  test('construction accepts a custom streamFn + getApiKey', () => {
    const streamFn = (() => undefined) as unknown as StreamFn;
    const session = new AgentSession({
      streamFn,
      getApiKey: () => 'k',
    });
    expect(session.getState().isStreaming).toBe(false);
  });

  test('setAuthToken + getAuthToken round-trip', () => {
    const session = new AgentSession();
    expect(session.getAuthToken()).toBeNull();
    session.setAuthToken('abc');
    expect(session.getAuthToken()).toBe('abc');
    session.setAuthToken(null);
    expect(session.getAuthToken()).toBeNull();
  });

  test('setTools accepts an empty array and tool list (smoke)', () => {
    const session = new AgentSession();
    // The inner Agent only reads `state.tools` at prompt time; setting it
    // should not throw and should allow the session to keep operating.
    session.setTools([]);
    const dummy = { name: 'dummy', description: 'd', parameters: {} } as unknown as AgentTool;
    session.setTools([dummy]);
    expect(session.getState().isStreaming).toBe(false);
  });

  test('setStreamFn replaces the inner Agent streamFn', () => {
    const session = new AgentSession();
    const streamFn: StreamFn = (() => undefined) as unknown as StreamFn;
    session.setStreamFn(streamFn);
    // No direct getter; just assert it does not throw.
    expect(() => session.setStreamFn(streamFn)).not.toThrow();
  });

  test('restoreMessages replaces the message buffer without firing events', () => {
    const session = new AgentSession();
    const events: AgentEvent[] = [];
    session.subscribe(e => {
      events.push(e);
    });
    const msgs = [userMessage('one'), userMessage('two')];
    session.restoreMessages(msgs);
    expect(session.getMessages()).toHaveLength(2);
    expect(session.getState().messageCount).toBe(2);
    // restoreMessages deliberately does not emit events; our subscriber
    // should have seen nothing.
    expect(events).toHaveLength(0);
  });

  test('reset clears the message buffer + derived state', () => {
    const session = new AgentSession();
    session.restoreMessages([userMessage('hi')]);
    expect(session.getState().messageCount).toBe(1);
    session.reset();
    expect(session.getState().messageCount).toBe(0);
    expect(session.getErrorMessage()).toBeUndefined();
    expect(session.getStreamingMessage()).toBeUndefined();
  });

  test('setSystemPrompt + setModel do not throw on basic input', () => {
    const session = new AgentSession();
    expect(() => session.setSystemPrompt('You are a test')).not.toThrow();
    expect(() => session.setModel(undefined)).not.toThrow();
  });

  test('subscribe returns an unsubscribe that stops further delivery', () => {
    const session = new AgentSession();
    let count = 0;
    const unsubscribe = session.subscribe(() => {
      count++;
    });
    unsubscribe();
    // No way to emit an event here without driving a prompt; this just
    // asserts the API shape + that unsubscribe is callable.
    expect(count).toBe(0);
  });
});
