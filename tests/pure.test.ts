import { expect, test } from 'claude-code/testing'

import { activityOf, barSvg, miniCharacterSvg, moodOf, sceneSvg } from '../hooks/drawings'
import { cleanName, isAccountId, isInference, newAccountId, withAccount } from '../hooks/routing'
import { headerLimits, mergeLimits, planRow, runsOutEarly, settle, shortLabel, sortAccounts } from '../hooks/usage'

const NOW = Date.parse('2026-11-24T12:00:00Z')

test('a response\'s headers give the 5-hour, weekly and Fable windows', async () => {
  const limits = headerLimits({
    'anthropic-ratelimit-unified-5h-reset': '1795493400',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.04',
    'Anthropic-Ratelimit-Unified-7d-Reset': '1795687200',
    'Anthropic-Ratelimit-Unified-7d-Utilization': '0.01',
    'anthropic-ratelimit-unified-7d_oi-reset': '1795687200',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.125',
    'anthropic-ratelimit-unified-status': 'allowed',
  })
  expect(limits).toEqual([
    { kind: 'five_hour', percentUsed: 4, resetsAt: new Date(1795493400000).toISOString() },
    { kind: 'seven_day', percentUsed: 1, resetsAt: new Date(1795687200000).toISOString() },
    { kind: 'seven_day_fable', percentUsed: 12.5, resetsAt: new Date(1795687200000).toISOString() },
  ])
  // A response with no such headers (an API key's, an error's) reads as nothing, never as 0%.
  expect(headerLimits({ 'content-type': 'application/json' })).toEqual([])
})

test('two readings of one window keep the higher figure until the reset', async () => {
  const at = '2026-11-29T22:00:00Z'
  expect(
    settle(
      { kind: 'seven_day', percentUsed: 16, resetsAt: at },
      { kind: 'seven_day', percentUsed: 17, resetsAt: '2026-11-29T21:59:59Z' },
    ).percentUsed,
  ).toBe(17)
  expect(
    settle(
      { kind: 'seven_day', percentUsed: 1, resetsAt: '2026-12-06T22:00:00Z' },
      { kind: 'seven_day', percentUsed: 17, resetsAt: at },
    ).percentUsed,
  ).toBe(1)
  // A window the fresh reading lacks (Fable, off a Fable request) is kept.
  expect(
    mergeLimits(
      [
        { kind: 'seven_day', percentUsed: 10, resetsAt: at },
        { kind: 'seven_day_fable', percentUsed: 12, resetsAt: at },
      ],
      [{ kind: 'seven_day', percentUsed: 11, resetsAt: at }],
    ).map(l => [l.kind, l.percentUsed]),
  ).toEqual([
    ['seven_day', 11],
    ['seven_day_fable', 12],
  ])
})

test('the pace warning speaks only when the window would run out first', async () => {
  const resetsAt = new Date(NOW + 5 * 24 * 3_600_000).toISOString() // two days into the week
  expect(runsOutEarly({ kind: 'seven_day', percentUsed: 40, resetsAt }, NOW)).toBe(true)
  expect(runsOutEarly({ kind: 'seven_day', percentUsed: 20, resetsAt }, NOW)).toBe(false)
  // Too early in the window, or too small a figure, to project from.
  expect(
    runsOutEarly({ kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + 6.5 * 24 * 3_600_000).toISOString() }, NOW),
  ).toBe(false)
  expect(runsOutEarly({ kind: 'seven_day', percentUsed: 5, resetsAt }, NOW)).toBe(false)
})

test('a rerouted request carries only the chosen token', async () => {
  expect(
    withAccount({ authorization: '[redacted]', 'x-api-key': 'k', 'anthropic-beta': 'oauth-2025-04-20' }, 'sk-ant-oat01-b'),
  ).toEqual({ 'anthropic-beta': 'oauth-2025-04-20', Authorization: 'Bearer sk-ant-oat01-b' })
  expect(isInference('https://api.anthropic.com/v1/messages?beta=true')).toBe(true)
  expect(isInference('https://api.anthropic.com/v1/messages/count_tokens')).toBe(true)
  expect(isInference('https://api.anthropic.com/api/oauth/usage')).toBe(false)
})

test('a token only ever goes to Anthropic\'s own API, over https', async () => {
  for (const url of [
    'https://gateway.example.com/v1/messages', // a custom base URL: a proxy or gateway
    'https://api.anthropic.com.evil.example/v1/messages', // a look-alike host
    'https://evil.example/api.anthropic.com/v1/messages',
    'https://user@evil.example/v1/messages',
    'http://api.anthropic.com/v1/messages', // not encrypted
    'https://api.anthropic.com:8443/v1/messages', // another port
    'https://api.anthropic.com/v1/messages/../../v2/other',
    'https://api.anthropic.com/v1/messagesX',
    'https://api.anthropic.com/v1/messages/batches',
    'http://localhost:8080/v1/messages',
    'not a url',
  ]) {
    expect(isInference(url)).toBe(false)
  }
})

test('account ids are safe file names, and names are tidied', async () => {
  expect(isAccountId(newAccountId(NOW))).toBe(true)
  expect(isAccountId('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).toBe(true)
  for (const bad of ['', '../x', 'a/b', '.hidden', 'a b', 'x'.repeat(65)]) expect(isAccountId(bad)).toBe(false)
  expect(cleanName('  Work \n account  ')).toBe('Work account')
  expect(cleanName('x'.repeat(50)).length).toBe(32)
  // "Account 10" sorts after "Account 2".
  const named = (label: string) => ({ id: label, label, limits: [], updatedAt: 0 })
  expect(sortAccounts([named('Account 10'), named('Account 2')]).map(a => a.label)).toEqual(['Account 2', 'Account 10'])
})

test('the character acts out the work and the usage', async () => {
  expect(activityOf('Bash')).toBe('running')
  expect(activityOf('Read')).toBe('reading')
  expect(activityOf('Edit')).toBe('writing')
  expect(activityOf('WebSearch')).toBe('browsing')
  expect(activityOf('mcp__Claude_Browser__navigate')).toBe('browsing')
  expect(activityOf('Agent')).toBe('delegating')
  expect(activityOf('SomethingElse')).toBe('thinking')

  const pose = (activity: Parameters<typeof miniCharacterSvg>[0]['activity']) =>
    miniCharacterSvg({ activity, mood: 'awake' })
  expect(pose('thinking')).toContain('class="dot"')
  expect(pose('reading')).toContain('class="scan"')
  expect(pose('writing')).toContain('class="scribble"')
  expect(pose('running')).toContain('class="step"')
  expect(pose('done')).toContain('class="jump"')
  // Asleep overrides whatever is going on; alarm shakes it.
  expect(miniCharacterSvg({ activity: 'running', mood: 'asleep' })).not.toContain('class="step"')
  expect(miniCharacterSvg({ activity: 'idle', mood: 'alarmed' })).toContain('class="shake"')

  const acct = (percentUsed: number) => ({ id: 'a', label: 'A', limits: [{ kind: 'seven_day', percentUsed }], updatedAt: NOW })
  expect(moodOf(acct(10), true, NOW)).toBe('awake')
  expect(moodOf(acct(85), true, NOW)).toBe('worried')
  expect(moodOf(acct(95), true, NOW)).toBe('alarmed')
  expect(moodOf(acct(95), false, NOW)).toBe('asleep')
})

test('the drawings hold no script and stop for reduced motion', async () => {
  expect(barSvg(50, 180)).toContain('<rect class="f" width="90"')
  expect(barSvg(0, 180)).toContain('<rect class="f" width="0"')
  // 1% still shows a sliver; 95% turns red and pulses.
  expect(barSvg(1, 180)).toContain('<rect class="f" width="4"')
  expect(barSvg(95, 180)).toMatch(/pulse 1\.4s[^]*fill="#e5604c"/)
  for (const svg of [
    barSvg(50, 56),
    sceneSvg({ activity: 'idle', mood: 'awake' }),
    sceneSvg({ activity: 'idle', mood: 'asleep' }),
    sceneSvg({ activity: 'running', mood: 'alarmed' }),
    miniCharacterSvg({ activity: 'writing', mood: 'worried' }),
  ]) {
    expect(svg).toContain('prefers-reduced-motion:reduce')
    expect(svg).not.toMatch(/<script|onload=|href=/)
  }
})

test('the row stays on one line however many accounts there are', async () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `Account ${i + 1}`)
  // Two accounts on a normal row: names, meters and figures.
  expect(planRow(names(2), 92, 'Use Account 1')).toEqual({ style: 'full', shown: 2 })
  // Three: the meters go, the figures stay.
  expect(planRow(names(3), 92, 'Use Account 1')).toEqual({ style: 'compact', shown: 3 })
  // Eight: as many as fit, the rest behind "+N more".
  const many = planRow(names(8), 92, 'Use Account 1')
  expect(many.style).toBe('compact')
  expect(many.shown).toBeGreaterThanOrEqual(2)
  expect(many.shown).toBeLessThan(8)
  // A narrow row still shows the account in use.
  expect(planRow(names(5), 30, 'Use Account 1').shown).toBe(1)
  // A long name is cut, never the layout.
  expect(shortLabel('Personal subscription for side projects')).toBe('Personal subs…')
  expect(shortLabel('Work')).toBe('Work')
})
