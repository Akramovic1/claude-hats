import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AccountUsage, Activity, Limit } from '../types'

import { activityOf, barSvg, miniBar, miniCharacterSvg, moodOf, poseAlt, sceneSvg, textColor } from './drawings'
import type { Pose } from './drawings'
import { cleanName, isAccountId, isInference, newAccountId, withAccount } from './routing'
import {
  ALERT_AT,
  agoText,
  effectivePercent,
  fullness,
  headerLimits,
  isAccount,
  mergeLimits,
  nameOf,
  planRow,
  runsOutEarly,
  sameList,
  shortKind,
  shortLabel,
  sortAccounts,
  sortedLimits,
  untilText,
  weekly,
} from './usage'

// claude-hats: one Claude, many hats. Several Claude subscriptions in one
// Claude Code, each account a hat it can put on.
//
// - A row above the prompt shows every account's weekly usage. Pressing an
//   account opens its 5-hour, weekly and Fable windows, with Rename and
//   Remove (asked twice) for it. "+ Add" on the row adds an account.
// - "Use this account" sends this app's model requests out as that account:
//   every request to the Messages API carries that account's token, from the
//   next message on. Nothing else about the session changes.
// - Usage is read from the responses themselves (their rate-limit headers),
//   so no other tool and no extra request is needed.
// - /accounts opens a pane with every account at once (and the same fields).
//
// Everything is kept under ~/.claude/claude-hats/:
//   accounts.json   every account's last reading (written here)
//   config.json     { "accounts": { "<id>": { "label": "Work" } } }
//   route.json      { "account": "<id>" }: the account in use, '' for this app's own
//   tokens/<id>     that account's `claude setup-token` token, saved by
//                   bin/save-token; this mod only ever reads it
//   emails/<id>     its email, where one was given to bin/save-token --email;
//                   shown beside its name (a setup token may not read the
//                   account's profile, so it cannot be looked up)

const PANE = 'accounts'
const TITLE = 'Accounts'
const REFRESH_MS = 30_000
// While an account waits for its token, its file is looked for this often.
const PENDING_MS = 2_500
const OWN_LABEL = 'Main account'
// `renaming` says which small edit is open, one at a time: an account's id
// while its name is a field, REMOVING + its id while Remove waits for a second
// press, or ADDING while the row's field for a new account is open.
const ADDING = '+'
const REMOVING = 'x:'

const accounts = atom({ plugin: 'hats', key: 'accounts' } as const, [], {
  shape: 'accounts-2',
})
const me = atom({ plugin: 'hats', key: 'me' } as const, '')
const now = atom({ plugin: 'hats', key: 'now' } as const, 0)
const expanded = atom({ plugin: 'hats', key: 'expanded' } as const, '')
const activity = atom({ plugin: 'hats', key: 'activity' } as const, 'idle')
const usable = atom({ plugin: 'hats', key: 'usable' } as const, [])
const renaming = atom({ plugin: 'hats', key: 'renaming' } as const, '')

type Config = { accounts: Record<string, { label?: string }> }

// ---------------------------------------------------------------- files

async function dir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''

  return `${home}/.claude/claude-hats`
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return undefined
  }
}

async function loadAccounts($: EngineInterface): Promise<AccountUsage[]> {
  const data = (await readJson($, `${await dir($)}/accounts.json`)) as { accounts?: unknown } | undefined
  const list = Array.isArray(data?.accounts) ? data.accounts : []

  return list.filter(isAccount)
}

async function saveAccounts($: EngineInterface, list: AccountUsage[]): Promise<void> {
  await $.fs.write(`${await dir($)}/accounts.json`, `${JSON.stringify({ accounts: list }, null, 2)}\n`)
}

async function loadConfig($: EngineInterface): Promise<Config> {
  const data = (await readJson($, `${await dir($)}/config.json`)) as { accounts?: unknown } | undefined
  const raw = data?.accounts
  const out: Config = { accounts: {} }
  if (typeof raw !== 'object' || raw === null) return out

  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAccountId(id) || typeof value !== 'object' || value === null) continue
    const label = (value as { label?: unknown }).label
    out.accounts[id] = { label: typeof label === 'string' && label !== '' ? label : undefined }
  }

  return out
}

async function saveConfig($: EngineInterface, config: Config): Promise<void> {
  await $.fs.write(`${await dir($)}/config.json`, `${JSON.stringify(config, null, 2)}\n`)
}

// -------------------------------------------------------------- routing

// The account this app is signed in to. The desktop app names it; elsewhere it
// is learned from the first response (the organization that answered).
let learnedOwn = ''

async function ownAccount($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')) ?? learnedOwn
}

async function loadRoute($: EngineInterface): Promise<string> {
  const data = (await readJson($, `${await dir($)}/route.json`)) as { account?: unknown } | undefined

  return typeof data?.account === 'string' ? data.account : ''
}

async function tokenFor($: EngineInterface, id: string): Promise<string | undefined> {
  if (!isAccountId(id)) return undefined
  try {
    const token = String(await $.fs.read(`${await dir($)}/tokens/${id}`)).trim()

    return token.startsWith('sk-ant-') ? token : undefined
  } catch {
    return undefined
  }
}

type Route = { id: string; token?: string }
let cachedRoute: { at: number; route: Route } | undefined

/**
 * The account this app's requests go out as: the chosen one while its token
 * is saved, else the app's own (no token: the request is left as it is).
 */
async function currentRoute($: EngineInterface): Promise<Route> {
  const t = await $.clock.now()
  if (cachedRoute && t - cachedRoute.at < 10_000) return cachedRoute.route
  const [own, chosen] = await Promise.all([ownAccount($), loadRoute($)])
  let route: Route = { id: own }
  if (chosen && chosen !== own) {
    const token = await tokenFor($, chosen)
    if (token) route = { id: chosen, token }
  }
  cachedRoute = { at: t, route }

  return route
}

/** The email a person gave for an account when saving its token; none when there is no such file. */
async function emailFor($: EngineInterface, id: string): Promise<string | undefined> {
  if (!isAccountId(id)) return undefined
  try {
    const email = String(await $.fs.read(`${await dir($)}/emails/${id}`)).trim()

    return /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email) ? email : undefined
  } catch {
    return undefined
  }
}

async function saveRoute($: EngineInterface, account: string): Promise<void> {
  await $.fs.write(`${await dir($)}/route.json`, `${JSON.stringify({ account })}\n`)
  cachedRoute = undefined
}

async function useAccount($: EngineInterface, id: string): Promise<void> {
  const own = await ownAccount($)
  const label = (await read($, accounts)).find(a => a.id === id)?.label ?? 'That account'
  if (id !== own && !(await tokenFor($, id))) {
    $.ui.toast(`${label} has no token saved yet. /accounts shows the two steps.`)

    return
  }
  await saveRoute($, id === own ? '' : id)
  await refresh($)
  $.ui.toast(`${label} is in use from your next message.`)
}

// ---------------------------------------------------------------- usage

const lastFullness = new Map<string, number>()

/** Folds a fresh reading of one account into the shared file and this session's state. */
async function recordLimits($: EngineInterface, id: string, fresh: Limit[], org: string | undefined): Promise<void> {
  if (!isAccountId(id) || fresh.length === 0) return

  const [list, config, t, envId, envEmail] = await Promise.all([
    loadAccounts($),
    loadConfig($),
    $.clock.now(),
    $.env.get('CLAUDE_CODE_ACCOUNT_UUID'),
    $.env.get('CLAUDE_CODE_USER_EMAIL'),
  ])
  const old = list.find(a => a.id === id)
  const entry: AccountUsage = {
    id,
    label: config.accounts[id]?.label ?? old?.label ?? OWN_LABEL,
    email: id === envId ? (envEmail ?? old?.email) : old?.email,
    org: org ?? old?.org,
    limits: mergeLimits(old?.limits ?? [], fresh),
    updatedAt: t,
  }
  // Written when something moved, or once a minute so "updated ..." stays honest.
  const isSame = old !== undefined && sameList([{ ...old, updatedAt: 0 }], [{ ...entry, updatedAt: 0 }])
  if (!isSame || t - (old?.updatedAt ?? 0) > 60_000) {
    await saveAccounts($, sortAccounts([...list.filter(a => a.id !== id), entry]))
  }
  await refresh($)

  // One toast as the account in use crosses the alert line, naming the one with the most room.
  const full = fullness(entry, t)
  const before = lastFullness.get(id) ?? -1
  lastFullness.set(id, full)
  if (full >= ALERT_AT && before < ALERT_AT && before >= 0 && id === (await read($, me))) {
    const canUse = await read($, usable)
    const best = (await read($, accounts))
      .filter(a => a.id !== id && canUse.includes(a.id))
      .sort((x, y) => fullness(x, t) - fullness(y, t))[0]
    $.ui.toast(
      best
        ? `${entry.label} is at ${Math.round(full)}%. ${best.label} is at ${Math.round(fullness(best, t))}%.`
        : `${entry.label} is at ${Math.round(full)}%.`,
    )
  }
}

/** What a model response says about the account it went out as. Never throws. */
async function afterResponse(
  $: EngineInterface,
  route: Route,
  status: number,
  headers: Record<string, string>,
): Promise<void> {
  try {
    if (status === 401 && route.token) {
      // A revoked or mistyped token: back to the app's own account.
      await saveRoute($, '')
      const label = (await read($, accounts)).find(a => a.id === route.id)?.label ?? 'The other account'
      $.ui.toast(`${label}'s token was refused, so Claude is back on its own account.`)
      await refresh($)

      return
    }
    const org = Object.entries(headers).find(([k]) => k.toLowerCase() === 'anthropic-organization-id')?.[1]
    let id = route.id
    if (!route.token && !id) {
      // No name for this app's own account: the one that organization belongs to, else a new one.
      id = (await loadAccounts($)).find(a => a.org !== undefined && a.org === org)?.id ?? 'main'
      learnedOwn = id
      cachedRoute = undefined
    }
    await recordLimits($, id, headerLimits(headers), org)
  } catch {
    // a reading missed: the next response brings another
  }
}

/** Reads the shared files into this session's state, and moves the countdowns on. */
async function refresh($: EngineInterface): Promise<void> {
  const [list, config, t, own, envId, envEmail] = await Promise.all([
    loadAccounts($),
    loadConfig($),
    $.clock.now(),
    ownAccount($),
    $.env.get('CLAUDE_CODE_ACCOUNT_UUID'),
    $.env.get('CLAUDE_CODE_USER_EMAIL'),
  ])

  // The names are the config's; an account named there with no reading yet still gets a row.
  const named = list.map(a => ({ ...a, label: config.accounts[a.id]?.label ?? a.label }))
  const known = new Set(named.map(a => a.id))
  const unread: AccountUsage[] = Object.entries(config.accounts)
    .filter(([id]) => !known.has(id))
    .map(([id, c]) => ({ id, label: c.label ?? id, limits: [], updatedAt: 0 }))
  const next: AccountUsage[] = []
  for (const a of sortAccounts([...named, ...unread])) {
    // Its email: the app's own from the environment, another's as given with its token.
    const email = a.id === envId && envEmail ? envEmail : (a.email ?? (await emailFor($, a.id)))
    next.push(email === a.email ? a : { ...a, email })
  }

  const canUse: string[] = []
  for (const a of next) {
    if (a.id === own || (await tokenFor($, a.id)) !== undefined) canUse.push(a.id)
  }

  if (!sameList(next, await read($, accounts))) await update($, accounts, () => next)
  if (canUse.join() !== (await read($, usable)).join()) await update($, usable, () => canUse)
  const inUse = (await currentRoute($)).id
  if (inUse !== (await read($, me))) await update($, me, () => inUse)
  await update($, now, () => t)
}

/**
 * Notices a token the moment bin/save-token writes it: while any account is
 * waiting for one, its file is looked for every few seconds, so the row shows
 * the account as ready at once instead of at the next slow refresh. With no
 * account waiting it reads two values and returns.
 */
async function watchPending($: EngineInterface): Promise<void> {
  try {
    const canUse = await read($, usable)
    const waiting = (await read($, accounts)).filter(a => !canUse.includes(a.id))
    for (const a of waiting) {
      if ((await tokenFor($, a.id)) === undefined) continue
      await refresh($)
      $.ui.toast(`${a.label} is ready. Open it and press Use this account.`)

      return
    }
  } catch {
    // the slow refresh still catches it
  }
}

// ------------------------------------------------------------- accounts

/** Adds an account by name; its token is saved separately, by bin/save-token. */
async function addAccount($: EngineInterface, text: string): Promise<string | undefined> {
  const label = cleanName(text)
  if (label === '') return undefined
  const config = await loadConfig($)
  const id = newAccountId(await $.clock.now())
  config.accounts[id] = { label }
  await saveConfig($, config)
  await refresh($)

  return id
}

async function renameAccount($: EngineInterface, id: string, text: string): Promise<boolean> {
  const label = cleanName(text)
  if (label === '' || !isAccountId(id)) return false
  const config = await loadConfig($)
  config.accounts[id] = { ...config.accounts[id], label }
  await saveConfig($, config)
  const list = await loadAccounts($)
  if (list.some(a => a.id === id)) {
    await saveAccounts($, sortAccounts(list.map(a => (a.id === id ? { ...a, label } : a))))
  }
  await update($, renaming, () => '')
  await refresh($)

  return true
}

/** Forgets an account: its name, its readings and its token. The app's own account stays. */
async function removeAccount($: EngineInterface, id: string): Promise<boolean> {
  if (!isAccountId(id) || id === (await ownAccount($))) return false
  const config = await loadConfig($)
  delete config.accounts[id]
  await saveConfig($, config)
  await saveAccounts($, (await loadAccounts($)).filter(a => a.id !== id))
  // No file can be deleted from here, so the token is overwritten with nothing.
  if (await $.fs.exists(`${await dir($)}/tokens/${id}`)) await $.fs.write(`${await dir($)}/tokens/${id}`, '')
  if ((await loadRoute($)) === id) await saveRoute($, '')
  cachedRoute = undefined
  await refresh($)

  return true
}

/** The account a person means: by its place in the list (1, 2, ...), its name, or its id. */
function findAccount(list: AccountUsage[], text: string): AccountUsage | undefined {
  const wanted = text.trim().toLowerCase()
  if (wanted === '') return undefined
  if (/^\d+$/.test(wanted)) return list[Number(wanted) - 1]

  return list.find(a => a.label.toLowerCase() === wanted) ?? list.find(a => a.id.toLowerCase() === wanted)
}

/** The one terminal command that gives an account its token: it makes one, checks it and saves it. */
function tokenStep(root: string, id: string): string {
  return `bash "${root}/bin/save-token" ${id}`
}

// ------------------------------------------------------------- drawing

let lastPoseAt = 0

/**
 * Sets what the character acts out. A drawing detail: it must never fail a
 * turn or a tool call. Every change redraws the row, so a tool's pose is
 * dropped when the last change was a moment ago; a turn's start and end
 * (`isFirm`) always show.
 */
async function setActivity($: EngineInterface, next: Activity, isFirm = false): Promise<void> {
  try {
    const t = await $.clock.now()
    if (!isFirm && t - lastPoseAt < 2500) return
    if ((await read($, activity)) !== next) {
      lastPoseAt = t
      await update($, activity, () => next)
    }
  } catch {
    // nothing to do: the pose just stays as it was
  }
}

/** Rows the opened details of one account take in the band. */
function detailRows(a: AccountUsage): number {
  // gaps above and below the header, the windows (the scene tile is three rows
  // tall), and the padding under them
  return 4 + Math.max(3, a.limits.length)
}

export const register: Register = on => {
  // Sends this app's model requests out as the account in use, and reads each
  // response's usage figures.
  on('http.fetch', async ($, e, next) => {
    if (next.origin.plugin !== 'engine' || !isInference(e.url)) return next(e)
    const route = await currentRoute($)
    const res = await next(
      route.token ? { ...e, init: { ...e.init, headers: withAccount(e.init?.headers, route.token) } } : e,
    )
    // Not awaited: the response goes on to the engine at once.
    if ('value' in res && res.value) void afterResponse($, route, res.value.status, res.value.headers)

    return res
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({ name: 'accounts', description: 'Usage of every Claude account; add, rename, remove' })
    await $.command.register({ name: 'accounts-add', description: 'Add an account: /accounts-add Work' })
    await $.command.register({ name: 'accounts-rename', description: 'Rename an account: /accounts-rename 2 = Work' })
    await $.command.register({ name: 'accounts-remove', description: 'Remove an account: /accounts-remove Work' })
    await refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    $.clock.every(PENDING_MS, () => void watchPending($))

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    await setActivity($, 'thinking', true)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // The pose stays until the next tool or the turn's end: no second redraw when the call returns.
    await setActivity($, activityOf(e.tool))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    await setActivity($, 'done', true)
    $.clock.after(6000, () => {
      void read($, activity).then(pose => (pose === 'done' ? setActivity($, 'idle', true) : undefined))
    })

    return out
  })

  on('command.run', { command: 'accounts' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Accounts pane opened.' }
  })

  on('command.run', { command: 'accounts-add' }, async ($, e) => {
    const id = await addAccount($, e.args)
    if (id === undefined) return { text: 'Give the account a name: /accounts-add Work' }
    return {
      text: `Added. To finish, run this in a terminal, with your browser signed in to claude.ai as that account. It sets the token up by itself:\n\n  ${tokenStep($.plugin.root, id)}`,
    }
  })

  on('command.run', { command: 'accounts-rename' }, async ($, e) => {
    const [who, name] = e.args.split('=')
    const account = findAccount(await read($, accounts), who ?? '')
    if (!account || name === undefined) return { text: 'Like this: /accounts-rename 2 = Work' }
    const isRenamed = await renameAccount($, account.id, name)

    return { text: isRenamed ? `${account.label} is now ${cleanName(name)}.` : 'That name is empty.' }
  })

  on('command.run', { command: 'accounts-remove' }, async ($, e) => {
    const account = findAccount(await read($, accounts), e.args)
    if (!account) return { text: 'Which one? /accounts-remove Work' }
    const isRemoved = await removeAccount($, account.id)

    return { text: isRemoved ? `${account.label} was removed.` : `${account.label} is this app's own account and stays.` }
  })

  // The band above the prompt: one line with every account's weekly figure;
  // the pressed account opens below it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, accounts)
    if (list.length === 0 || e.props.hasSurvey) return next(e)

    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const mine = await read($, me)
    const open = await read($, expanded)
    const canUse = await read($, usable)
    const t = (await read($, now)) || (await $.clock.now())
    const sel = e.props.isCollapsed ? undefined : list.find(a => a.id === open)
    const own = await ownAccount($)
    // The field for a new account's name, opened by "+ Add" on the row.
    const edit = e.props.isCollapsed ? '' : await read($, renaming)
    const isAdding = edit === ADDING
    const isRenaming = sel !== undefined && edit === sel.id
    const isConfirming = sel !== undefined && edit === REMOVING + sel.id
    // Too little room to open here: the pane holds the details instead.
    const fits = sel !== undefined && 1 + detailRows(sel) + (isAdding ? 2 : 0) <= e.props.maxRows
    // The account in use comes first.
    const ordered = [...list.filter(a => a.id === mine), ...list.filter(a => a.id !== mine)]
    const inUse = ordered.find(a => a.id === mine)
    // One press moves to the account with the most room left.
    const nextUp = ordered
      .filter(a => a.id !== mine && canUse.includes(a.id))
      .sort((x, y) => fullness(x, t) - fullness(y, t))[0]
    const stored = (await read($, activity)) as Activity
    // The surface knows whether a turn is running; the tool hooks know with what.
    const doing: Activity = e.props.isWorking
      ? stored === 'idle' || stored === 'done'
        ? 'thinking'
        : stored
      : stored === 'done'
        ? 'done'
        : 'idle'
    const poseFor = (a: AccountUsage): Pose =>
      a.id === mine ? { activity: doing, mood: moodOf(a, true, t) } : { activity: 'idle', mood: 'asleep' }
    // One line whatever the number of accounts: meters while they fit, then
    // figures alone, then the rest behind "+N more".
    const hasQuick = nextUp !== undefined && !(sel && fits)
    const plan = planRow(
      ordered.map(a => a.label),
      e.props.bodyColumns,
      hasQuick && nextUp
        ? `Use ${shortLabel(nextUp.label)}`
        : sel && fits
          ? `${sel.id !== mine && canUse.includes(sel.id) ? 'Use this account  ' : ''}x`
          : undefined,
    )
    // The recommended account is never one of the hidden ones: it takes the last place shown.
    const firstShown = ordered.slice(0, plan.shown)
    const visible =
      nextUp && plan.shown > 1 && !firstShown.includes(nextUp) ? [...firstShown.slice(0, -1), nextUp] : firstShown
    const hiddenCount = ordered.length - visible.length

    return (
      <Box flexDirection="column" paddingX={1} paddingBottom={(sel && fits) || isAdding ? 1 : 0}>
        <Box flexDirection="row" alignItems="center" gap={2} flexWrap="nowrap">
          {Svg && inUse && (
            <Box key="character" flexShrink={0}>
              <Svg source={miniCharacterSvg(poseFor(inUse))} alt={poseAlt(poseFor(inUse))} width={30} height={26} />
            </Box>
          )}
          <Text dimColor size="footnote" wrap="truncate">
            Weekly
          </Text>
          {visible.map(a => {
            const w = weekly(a)
            const p = w ? effectivePercent(w, t) : undefined

            return (
              <Box key={`chip-${a.id}`} flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
                <Button
                  key={`acct-${a.id}`}
                  plain
                  label={`${a.id === mine ? '● ' : ''}${shortLabel(a.label)} ${a.id === open ? '▾' : '▸'}`}
                  onPress={async () => {
                    const willOpen = (await read($, expanded)) !== a.id
                    await update($, renaming, () => '')
                    await update($, expanded, () => (willOpen ? a.id : ''))
                    if (willOpen && 1 + detailRows(a) > e.props.maxRows) {
                      await $.ui.open({ id: PANE, title: TITLE, focus: true })
                    }
                  }}
                />
                {p === undefined || w === undefined ? (
                  <Text dimColor size="footnote" wrap="truncate">
                    {canUse.includes(a.id) ? 'no reading yet' : 'needs a token'}
                  </Text>
                ) : (
                  <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
                    {plan.style === 'full' &&
                      (Svg ? (
                        <Svg source={barSvg(p, 56)} alt={`${Math.round(p)}% used`} width={56} height={6} />
                      ) : (
                        <Text color={textColor(p)}>{miniBar(p)}</Text>
                      ))}
                    <Text tabular weight="semibold" color={textColor(p)} wrap="truncate">
                      {Math.round(p)}%
                    </Text>
                    {w.kind !== 'seven_day' && (
                      <Text dimColor size="footnote" wrap="truncate">
                        {shortKind(w.kind)}
                      </Text>
                    )}
                  </Box>
                )}
              </Box>
            )
          })}
          {/* The quick switch belongs to the closed row. An opened card speaks for its own account
              ("Use this account"), so with several accounts there is never a doubt which one a button means. */}
          {hiddenCount > 0 && (
            <Button
              key="more-accounts"
              plain
              dimColor
              label={`+${hiddenCount} more`}
              onPress={() => $.ui.open({ id: PANE, title: TITLE, focus: true })}
            />
          )}
          <Button
            key="add-toggle"
            plain
            dimColor
            label={isAdding ? 'Cancel' : '+ Add'}
            onPress={() => update($, renaming, value => (value === ADDING ? '' : ADDING))}
          />
          {/* The row's right end is the one place for actions: an opened account's own, else the quick switch. */}
          {sel && fits && (
            <Box key="card-actions" flexGrow={1} flexDirection="row" gap={1} alignItems="center" justifyContent="flex-end">
              {sel.id !== mine && canUse.includes(sel.id) && (
                <Button key={`switch-${sel.id}`} label="Use this account" onPress={() => useAccount($, sel.id)} />
              )}
              <Button
                key="close-details"
                plain
                dimColor
                label="✕"
                onPress={async () => {
                  await update($, renaming, () => '')
                  await update($, expanded, () => '')
                }}
              />
            </Box>
          )}
          {hasQuick && nextUp && (
            <Box flexGrow={1} flexDirection="row" justifyContent="flex-end">
              <Button
                key="quick-switch"
                label={`Use ${shortLabel(nextUp.label)}`}
                onPress={() => useAccount($, nextUp.id)}
              />
            </Box>
          )}
        </Box>
        {sel && fits && (
          <Box key={`details-${sel.id}`} flexDirection="column" marginTop={1} gap={1}>
            {/* One calm line: the name leads, its state follows, and the two edits wait at the far end. */}
            <Box flexDirection="row" alignItems="center" justifyContent="space-between">
              <Box flexDirection="row" alignItems="center" gap={1}>
                {isRenaming ? (
                  <Box width={22} flexShrink={0} flexDirection="column">
                    <Input
                      key={`name-${sel.id}`}
                      value={sel.label}
                      placeholder="Account name"
                      submitLabel="save"
                      autoFocus
                      onSubmit={value => renameAccount($, sel.id, value)}
                    />
                  </Box>
                ) : (
                  <Text weight="semibold">{sel.label}</Text>
                )}
                {sel.email && !isRenaming && (
                  <Text dimColor size="footnote" wrap="truncate">
                    ({sel.email})
                  </Text>
                )}
                {sel.id === mine && (
                  <Text size="footnote" color="success">
                    In use
                  </Text>
                )}
                <Text dimColor size="footnote" wrap="truncate">
                  {canUse.includes(sel.id) ? agoText(sel.updatedAt, t) : 'needs a token'}
                </Text>
              </Box>
              <Box flexDirection="row" alignItems="center" gap={2} flexShrink={0}>
                <Button
                  key={`rename-${sel.id}`}
                  plain
                  dimColor
                  label={isRenaming ? 'Cancel' : 'Rename'}
                  onPress={() => update($, renaming, value => (value === sel.id ? '' : sel.id))}
                />
                {sel.id !== own &&
                  (isConfirming ? (
                    <Button
                      key={`remove-${sel.id}`}
                      label="Confirm remove"
                      onPress={async () => {
                        await update($, renaming, () => '')
                        await update($, expanded, () => '')
                        await removeAccount($, sel.id)
                      }}
                    />
                  ) : (
                    <Button
                      key={`remove-${sel.id}`}
                      plain
                      dimColor
                      label="Remove"
                      onPress={() => update($, renaming, () => REMOVING + sel.id)}
                    />
                  ))}
              </Box>
            </Box>
            <Box flexDirection="row" alignItems="center" gap={2}>
              {Svg && (
                <Svg source={sceneSvg(poseFor(sel))} alt={poseAlt(poseFor(sel))} width={104} height={60} />
              )}
              <Box flexDirection="column" flexGrow={1}>
                {sel.limits.length === 0 && canUse.includes(sel.id) && (
                  <Text dimColor>No reading yet. It appears after the first message sent from this account.</Text>
                )}
                {!canUse.includes(sel.id) && (
                  <Box key={`steps-${sel.id}`} flexDirection="column">
                    <Text dimColor>
                      To finish, run this one command in a terminal, with your browser signed in to claude.ai as this
                      account. It sets the token up by itself:
                    </Text>
                    <Text mono>{tokenStep($.plugin.root, sel.id)}</Text>
                  </Box>
                )}
                {sortedLimits(sel.limits).map(l => {
                  const p = effectivePercent(l, t)

                  return (
                    <Box key={`row-${sel.id}-${l.kind}`} flexDirection="row" alignItems="center" gap={2}>
                      <Box width={6} flexShrink={0}>
                        <Text dimColor wrap="truncate">
                          {nameOf(l.kind)}
                        </Text>
                      </Box>
                      <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
                        {Svg ? (
                          <Svg source={barSvg(p, 180)} alt={`${Math.round(p)}% used`} width={180} height={6} />
                        ) : (
                          <Text color={textColor(p)}>{miniBar(p, 16)}</Text>
                        )}
                        <Box width={4} flexShrink={0} justifyContent="flex-end">
                          <Text tabular weight="semibold" color={textColor(p)}>
                            {Math.round(p)}%
                          </Text>
                        </Box>
                      </Box>
                      <Text dimColor size="footnote" wrap="truncate">
                        {untilText(l.resetsAt, t)}
                      </Text>
                      {runsOutEarly(l, t) && (
                        <Text color="warning" size="footnote" wrap="truncate">
                          runs out early
                        </Text>
                      )}
                    </Box>
                  )
                })}
              </Box>
            </Box>
          </Box>
        )}
        {isAdding && (
          <Box key="add-row" flexDirection="column" marginTop={1}>
            <Input
              key="add-account"
              label="New account"
              placeholder="its name, such as Work"
              submitLabel="add"
              autoFocus
              onSubmit={async value => {
                const id = await addAccount($, value)
                await update($, renaming, () => '')
                // Its card opens next, with the two steps that give it a token.
                if (id !== undefined) await update($, expanded, () => id)
              }}
            />
          </Box>
        )}
      </Box>
    )
  })

  // The pane on /accounts: every account opened, and where accounts are
  // added, renamed and removed.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const list = await read($, accounts)
    const mine = await read($, me)
    const canUse = await read($, usable)
    const editing = await read($, renaming)
    const own = await ownAccount($)
    const t = (await read($, now)) || (await $.clock.now())
    const doing = (await read($, activity)) as Activity
    const poseFor = (a: AccountUsage): Pose =>
      a.id === mine ? { activity: doing, mood: moodOf(a, true, t) } : { activity: 'idle', mood: 'asleep' }

    return (
      <Box flexDirection="column" gap={2}>
        {list.length === 0 && <Text dimColor>No usage yet. It appears after your first message.</Text>}
        {list.map(a => (
          <Box key={`acct-${a.id}`} flexDirection="column" gap={1}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Box flexDirection="column">
                <Box flexDirection="row" alignItems="center" gap={1}>
                  <Text weight="semibold">{a.label}</Text>
                  {a.id === mine && (
                    <Text size="footnote" color="success">
                      In use
                    </Text>
                  )}
                </Box>
                {a.email && a.email !== a.label && (
                  <Text dimColor size="footnote">
                    {a.email}
                  </Text>
                )}
              </Box>
              <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                {a.id !== mine && canUse.includes(a.id) && (
                  <Button key={`switch-${a.id}`} label="Use this account" onPress={() => useAccount($, a.id)} />
                )}
                <Button
                  key={`rename-${a.id}`}
                  plain
                  dimColor
                  label="Rename"
                  onPress={() => update($, renaming, id => (id === a.id ? '' : a.id))}
                />
                {a.id !== own &&
                  (editing === REMOVING + a.id ? (
                    <Button
                      key={`remove-${a.id}`}
                      label="Confirm remove"
                      onPress={async () => {
                        await update($, renaming, () => '')
                        await removeAccount($, a.id)
                      }}
                    />
                  ) : (
                    <Button
                      key={`remove-${a.id}`}
                      plain
                      dimColor
                      label="Remove"
                      onPress={() => update($, renaming, () => REMOVING + a.id)}
                    />
                  ))}
              </Box>
            </Box>
            {editing === a.id && (
              <Input
                key={`name-${a.id}`}
                label="New name"
                value={a.label}
                submitLabel="save"
                autoFocus
                onSubmit={value => renameAccount($, a.id, value)}
              />
            )}
            {canUse.includes(a.id) ? (
              <Box flexDirection="row" alignItems="center" gap={2}>
                {Svg && (
                  <Svg source={sceneSvg(poseFor(a))} alt={poseAlt(poseFor(a))} width={104} height={60} />
                )}
                <Box flexDirection="column" flexGrow={1}>
                  {a.limits.length === 0 && <Text dimColor>No reading yet for this account.</Text>}
                  {sortedLimits(a.limits).map(l => {
                    const p = effectivePercent(l, t)

                    return (
                      <Box key={`row-${a.id}-${l.kind}`} flexDirection="row" alignItems="center" gap={2}>
                        <Box width={6} flexShrink={0}>
                          <Text dimColor wrap="truncate">
                            {nameOf(l.kind)}
                          </Text>
                        </Box>
                        <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
                          {Svg ? (
                            <Svg source={barSvg(p, 120)} alt={`${Math.round(p)}% used`} width={120} height={6} />
                          ) : (
                            <Text color={textColor(p)}>{miniBar(p, 12)}</Text>
                          )}
                          <Box width={4} flexShrink={0} justifyContent="flex-end">
                            <Text tabular weight="semibold" color={textColor(p)}>
                              {Math.round(p)}%
                            </Text>
                          </Box>
                        </Box>
                        <Text dimColor size="footnote" wrap="truncate">
                          {untilText(l.resetsAt, t)}
                        </Text>
                        {runsOutEarly(l, t) && (
                          <Text color="warning" size="footnote" wrap="truncate">
                            runs out early
                          </Text>
                        )}
                      </Box>
                    )
                  })}
                </Box>
              </Box>
            ) : (
              <Box key={`steps-${a.id}`} flexDirection="column">
                <Text dimColor>
                  To finish, run this one command in a terminal, with your browser signed in to claude.ai as this
                  account. It sets the token up by itself:
                </Text>
                <Text mono>{tokenStep($.plugin.root, a.id)}</Text>
              </Box>
            )}
            {a.updatedAt > 0 && (
              <Text dimColor size="footnote">
                {agoText(a.updatedAt, t)}
              </Text>
            )}
          </Box>
        ))}
        <Input
          key="add-account"
          label="Add an account"
          placeholder="its name, such as Work"
          submitLabel="add"
          onSubmit={value => {
            void addAccount($, value)
          }}
        />
      </Box>
    )
  })
}
