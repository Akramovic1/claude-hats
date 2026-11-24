import { expect, test } from 'claude-code/testing'

const A1 = '11111111-1111-1111-1111-111111111111' // this app's own account
const A2 = '22222222-2222-2222-2222-222222222222'
const A3 = 'acct-third'
const NOW = Date.parse('2026-11-24T12:00:00Z')
const HOME = '/home/test/.claude/claude-hats'
const TOKEN = 'sk-ant-oat01-test\n'

const TWO = {
  accounts: [
    {
      id: A1,
      label: 'Account 1',
      limits: [
        { kind: 'five_hour', percentUsed: 34, resetsAt: '2026-11-24T14:10:00Z' },
        { kind: 'seven_day', percentUsed: 12, resetsAt: '2026-11-28T00:00:00Z' },
      ],
      updatedAt: NOW - 5 * 60_000,
    },
    {
      id: A2,
      label: 'Account 2',
      // Its 5-hour window reset an hour ago: it counts as 0% again.
      limits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: '2026-11-24T11:00:00Z' }],
      updatedAt: NOW - 3 * 3_600_000,
    },
  ],
}

const BAND = {
  plugin: 'hats',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'hats',
  component: 'Pane',
  requestId: 'accounts',
  props: {
    title: 'Accounts',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** Stands for the engine beneath the mod, with a small file system in memory. */
function engine(on: any, saved: unknown = TWO, extra: Record<string, string> = {}) {
  const files = new Map<string, string>([[`${HOME}/accounts.json`, JSON.stringify(saved)]])
  for (const [name, text] of Object.entries(extra)) files.set(`${HOME}/${name}`, text)

  on('env.get', (_: unknown, e: { name: string }) => ({
    value: ({ HOME: '/home/test', CLAUDE_CODE_ACCOUNT_UUID: A1, CLAUDE_CODE_USER_EMAIL: 'one@example.com' } as Record<string, string>)[e.name],
  }))
  on('fs.read', (_: unknown, e: { path: string }) =>
    files.has(e.path) ? { value: files.get(e.path) } : { deny: 'missing' },
  )
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: files.has(e.path) }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))

  return files
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

test('the row shows each account\'s weekly figure, the one in use first', async ($, on) => {
  engine(on)
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ key: `acct-${A1}` }))?.text).toBe('● Account 1 ▸')
  expect((await ui.find({ key: `chip-${A1}` }))?.text).toMatch(/12%$/)
  // Account 2 has no weekly window: its 5-hour one, reset an hour ago, stands in at 0%.
  expect((await ui.find({ key: `acct-${A2}` }))?.text).toBe('Account 2 ▸')
  expect((await ui.find({ key: `chip-${A2}` }))?.text).toMatch(/0%5h$/)
  await ui.unmount()
})

test('an opened account lists its windows; only one switch button shows at a time', async ($, on) => {
  engine(on, TWO, { [`tokens/${A2}`]: TOKEN })
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // Closed, the row offers the other account in one press.
  expect((await ui.find({ key: 'quick-switch' }))?.text).toBe('Use Account 2')

  await ui.press({ key: `acct-${A1}` })
  expect((await ui.find({ key: `row-${A1}-five_hour` }))?.text).toMatch(/5-hour.*34%.*resets in 2h 10m/)
  expect((await ui.find({ key: `row-${A1}-seven_day` }))?.text).toMatch(/Weekly.*12%.*resets in 3d 12h/)
  // The account in use has nothing to switch to, and an opened card hides the quick switch.
  expect(await ui.find({ key: `switch-${A1}` })).toBeUndefined()
  expect(await ui.find({ key: 'quick-switch' })).toBeUndefined()

  await ui.press({ key: `acct-${A2}` })
  expect((await ui.find({ key: `switch-${A2}` }))?.text).toBe('Use this account')
  expect(await ui.find({ key: 'quick-switch' })).toBeUndefined()

  await ui.press({ key: 'close-details' })
  expect((await ui.find({ key: 'quick-switch' }))?.text).toBe('Use Account 2')
  await ui.unmount()
})

test('with several accounts the quick switch goes to the one with the most room', async ($, on) => {
  const three = {
    accounts: [
      TWO.accounts[0],
      { id: A2, label: 'Account 2', limits: [{ kind: 'seven_day', percentUsed: 60, resetsAt: '2026-11-28T00:00:00Z' }], updatedAt: NOW },
      { id: A3, label: 'Account 3', limits: [{ kind: 'seven_day', percentUsed: 8, resetsAt: '2026-11-28T00:00:00Z' }], updatedAt: NOW },
      { id: 'acct-fourth', label: 'Account 4', limits: [], updatedAt: 0 },
    ],
  }
  engine(on, three, { [`tokens/${A2}`]: TOKEN, [`tokens/${A3}`]: TOKEN })
  await start($)

  // A wide row, so all four are on it.
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 120 } })
  expect((await ui.find({ key: 'quick-switch' }))?.text).toBe('Use Account 3')
  // Four accounts do not fit with meters: figures alone, all on one line.
  expect(JSON.stringify(await ui.find({ key: `chip-${A2}` }))).not.toContain('Svg')
  expect((await ui.find({ key: `chip-${A2}` }))?.text).toMatch(/60%$/)
  // An account with no token is listed, and is never offered.
  expect((await ui.find({ key: 'chip-acct-fourth' }))?.text).toMatch(/needs a token$/)
  await ui.press({ key: 'acct-acct-fourth' })
  expect(await ui.find({ key: 'switch-acct-fourth' })).toBeUndefined()
  await ui.unmount()
})

test('pressing Use this account moves the app to that account', async ($, on) => {
  const files = engine(on, TWO, { [`tokens/${A2}`]: TOKEN })
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'quick-switch' })
  expect(JSON.parse(files.get(`${HOME}/route.json`) ?? '{}')).toEqual({ account: A2 })
  await ui.unmount()
})

test('a saved choice is honored only while that account\'s token is there', async ($, on) => {
  engine(on, TWO, { 'route.json': JSON.stringify({ account: A2 }) })
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ key: `acct-${A1}` }))?.text).toBe('● Account 1 ▸')
  await ui.unmount()
})

test('with its token saved, the chosen account is the one in use', async ($, on) => {
  engine(on, TWO, { 'route.json': JSON.stringify({ account: A2 }), [`tokens/${A2}`]: TOKEN })
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ key: `acct-${A2}` }))?.text).toBe('● Account 2 ▸')
  expect((await ui.find({ key: 'quick-switch' }))?.text).toBe('Use Account 1')
  await ui.unmount()
})

test('accounts are added, renamed and removed', async ($, on) => {
  const files = engine(on, TWO, { [`tokens/${A2}`]: TOKEN })
  await start($)
  const config = () => JSON.parse(files.get(`${HOME}/config.json`) ?? '{"accounts":{}}').accounts as Record<string, { label: string }>

  // Added by name: it appears at once, with the two steps that give it a token.
  const added = await $.command.run({ command: 'accounts-add', args: '  Work  ' })
  const id = Object.keys(config()).find(k => config()[k]?.label === 'Work') ?? ''
  expect(id).toMatch(/^acct-/)
  expect(JSON.stringify(added)).toContain(`save-token\\" ${id}`)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ key: `steps-${id}` }))?.text).toContain('claude setup-token')
  expect(await pane.find({ key: `switch-${id}` })).toBeUndefined()

  // Renamed from the pane: the field opens on Rename and saves on Enter.
  await pane.press({ key: `rename-${A2}` })
  await pane.input({ key: `name-${A2}`, text: 'Personal' })
  expect(config()[A2]?.label).toBe('Personal')
  expect((await pane.find({ key: `acct-${A2}` }))?.text).toContain('Personal')
  await pane.unmount()

  // And by command, by its place in the list or its name.
  await $.command.run({ command: 'accounts-rename', args: 'personal = Side' })
  expect(config()[A2]?.label).toBe('Side')

  // Removed: its name, readings and token go; the app's own account cannot be.
  await $.command.run({ command: 'accounts-remove', args: 'Side' })
  expect(config()[A2]).toBeUndefined()
  expect(files.get(`${HOME}/tokens/${A2}`)).toBe('')
  expect(JSON.parse(files.get(`${HOME}/accounts.json`) ?? '{}').accounts.map((a: { id: string }) => a.id)).toEqual([A1])
  const kept = await $.command.run({ command: 'accounts-remove', args: 'Account 1' })
  expect(JSON.stringify(kept)).toContain('stays')
})

test('while a turn runs with no tool in flight, the character is thinking', async ($, on) => {
  engine(on)
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: true } })
  expect(JSON.stringify(await ui.find({ key: 'character' }))).toContain('The character is thinking')
  await ui.unmount()
})

test('more accounts than fit are gathered behind "+N more"', async ($, on) => {
  const many = {
    accounts: Array.from({ length: 9 }, (_, i) => ({
      id: i === 0 ? A1 : `acct-n${i}`,
      label: `Account ${i + 1}`,
      limits: [{ kind: 'seven_day', percentUsed: 10 + i, resetsAt: '2026-11-28T00:00:00Z' }],
      updatedAt: NOW,
    })),
  }
  engine(on, many)
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ key: `acct-${A1}` }))?.text).toBe('● Account 1 ▸')
  expect((await ui.find({ key: 'more-accounts' }))?.text).toMatch(/^\+\d more$/)
  expect(await ui.find({ key: 'chip-acct-n8' })).toBeUndefined()
  await ui.unmount()
})

test('an opened card renames and removes its account; "+ Add" on the row adds one', async ($, on) => {
  const files = engine(on, TWO, { [`tokens/${A2}`]: TOKEN })
  await start($)
  const config = () => JSON.parse(files.get(`${HOME}/config.json`) ?? '{"accounts":{}}').accounts as Record<string, { label: string }>

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // Rename turns the opened card's name into a field; Enter saves and the field goes.
  await ui.press({ key: `acct-${A2}` })
  expect(await ui.find({ key: `name-${A2}` })).toBeUndefined()
  await ui.press({ key: `rename-${A2}` })
  expect((await ui.find({ key: `rename-${A2}` }))?.text).toBe('Cancel')
  await ui.input({ key: `name-${A2}`, text: 'Side' })
  expect(await ui.find({ key: `name-${A2}` })).toBeUndefined()
  expect(config()[A2]?.label).toBe('Side')
  expect((await ui.find({ key: `acct-${A2}` }))?.text).toBe('Side ▾')
  // There is no Manage button to go through.
  expect(await ui.find({ key: 'manage' })).toBeUndefined()

  // "+ Add" opens one field; the new account's card opens with the two steps for its token.
  expect(await ui.find({ key: 'add-account' })).toBeUndefined()
  await ui.press({ key: 'add-toggle' })
  expect((await ui.find({ key: 'add-toggle' }))?.text).toBe('Cancel')
  await ui.input({ key: 'add-account', text: 'Work' })
  const id = Object.keys(config()).find(k => config()[k]?.label === 'Work') ?? ''
  expect(id).toMatch(/^acct-/)
  expect(await ui.find({ key: 'add-account' })).toBeUndefined()
  expect((await ui.find({ key: `steps-${id}` }))?.text).toContain(`save-token" ${id}`)
  expect(await ui.find({ key: `switch-${id}` })).toBeUndefined()

  // Remove asks twice: the first press only arms it, and closing the card disarms it.
  await ui.press({ key: `remove-${id}` })
  expect((await ui.find({ key: `remove-${id}` }))?.text).toBe('Confirm remove')
  expect(config()[id]?.label).toBe('Work')
  await ui.press({ key: 'close-details' })
  await ui.press({ key: `acct-${id}` })
  expect((await ui.find({ key: `remove-${id}` }))?.text).toBe('Remove')
  // The second press forgets the account and closes the card.
  await ui.press({ key: `remove-${id}` })
  await ui.press({ key: `remove-${id}` })
  expect(config()[id]).toBeUndefined()
  expect(await ui.find({ key: `acct-${id}` })).toBeUndefined()
  // The app's own account has no Remove.
  await ui.press({ key: `acct-${A1}` })
  expect(await ui.find({ key: `remove-${A1}` })).toBeUndefined()
  await ui.unmount()
})

test('among many accounts, the one with the most room is recommended and stays on the row', async ($, on) => {
  // Nine accounts; the least used is the last by name, and would otherwise be behind "+N more".
  const many = {
    accounts: Array.from({ length: 9 }, (_, i) => ({
      id: i === 0 ? A1 : `acct-n${i}`,
      label: `Account ${i + 1}`,
      limits: [
        { kind: 'seven_day', percentUsed: i === 8 ? 3 : 40 + i, resetsAt: '2026-11-28T00:00:00Z' },
        // A nearly spent 5-hour window counts against an account even when its week is light.
        ...(i === 1 ? [{ kind: 'five_hour', percentUsed: 97, resetsAt: '2026-11-24T14:00:00Z' }] : []),
      ],
      updatedAt: NOW,
    })),
  }
  const tokens = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`tokens/acct-n${i + 1}`, TOKEN]))
  engine(on, many, tokens)
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ key: 'quick-switch' }))?.text).toBe('Use Account 9')
  expect((await ui.find({ key: 'chip-acct-n8' }))?.text).toMatch(/3%$/)
  expect((await ui.find({ key: `acct-${A1}` }))?.text).toBe('● Account 1 ▸')
  expect((await ui.find({ key: 'more-accounts' }))?.text).toBe('+7 more')
  await ui.unmount()
})

test('an opened card shows the account\'s email in brackets beside its name', async ($, on) => {
  engine(on, TWO, { [`tokens/${A2}`]: TOKEN, [`emails/${A2}`]: 'two@example.com\n' })
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // The app's own account: its email comes from the app.
  await ui.press({ key: `acct-${A1}` })
  expect((await ui.find({ key: `details-${A1}` }))?.text).toContain('Account 1(one@example.com)')
  // Another account: the email given when its token was saved.
  await ui.press({ key: `acct-${A2}` })
  expect((await ui.find({ key: `details-${A2}` }))?.text).toContain('Account 2(two@example.com)')
  // The row itself stays short: names only.
  expect((await ui.find({ key: `acct-${A2}` }))?.text).toBe('Account 2 ▾')
  await ui.unmount()
})
