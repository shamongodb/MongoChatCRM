import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShortTermContext,
  buildUserProfileContext,
  buildUserProfileOnboardingContext,
  extractLatestUserTurn
} from '../src/memory/context.js';

test('extractLatestUserTurn returns the latest user message', () => {
  const messages = [
    { role: 'user', content: 'First' },
    { role: 'assistant', content: 'Reply' },
    { role: 'user', content: 'Newest' }
  ];
  const out = extractLatestUserTurn(messages);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'Newest');
});

test('buildShortTermContext injects summary and recent context', () => {
  const out = buildShortTermContext({
    summaryText: 'User prefers concise replies.',
    recentMessages: [
      { role: 'assistant', content: 'What should we do next?' },
      { role: 'user', content: 'Draft an email.' }
    ],
    incomingMessages: [{ role: 'user', content: 'Draft an email.' }],
    maxRecentMessages: 12
  });
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /Conversation memory summary/);
  assert.equal(out.length, 3);
  assert.equal(out[2].content, 'Draft an email.');
});

test('buildUserProfileContext returns bounded profile system message', () => {
  const out = buildUserProfileContext({
    displayName: 'Shaun',
    role: 'VP Sales',
    organization: 'Acme',
    timezone: 'America/New_York',
    aliases: { myTeam: 'North America sales team' },
    preferences: { responseStyle: 'concise' },
    constraints: ['Never send email without confirmation']
  });
  assert.equal(out.role, 'system');
  assert.match(out.content, /Known user profile memory/);
  assert.match(out.content, /myTeam/);
});

test('buildShortTermContext includes user profile memory before summary', () => {
  const out = buildShortTermContext({
    summaryText: 'User prefers concise replies.',
    recentMessages: [{ role: 'user', content: 'Can you draft this?' }],
    incomingMessages: [{ role: 'user', content: 'Can you draft this?' }],
    userProfile: { displayName: 'Shaun', aliases: { myCalendar: 'Sales calendar' } },
    maxRecentMessages: 12
  });
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /Known user profile memory/);
  assert.equal(out[1].role, 'system');
  assert.match(out[1].content, /Conversation memory summary/);
});

test('buildUserProfileOnboardingContext is disabled when user profile is missing', () => {
  const out = buildUserProfileOnboardingContext({
    userId: 'user-123',
    userProfile: null
  });
  assert.equal(out, null);
});
