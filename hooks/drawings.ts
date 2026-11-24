// Everything the mod draws as an image: the meters, and the character with
// its scene. Pure functions from data to SVG text.
// The drawings cannot read the app's theme, so their colors are chosen to
// read on dark and on light, and every animation stops under
// prefers-reduced-motion.

import type { AccountUsage, Activity } from '../types'
import { ALERT_AT, WARN_AT, busiest, effectivePercent } from './usage'

/** A text bar of `cells` cells for a percentage: ▰▰▰▱▱▱▱▱. */
export function miniBar(percent: number, cells = 8): string {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

type Tone = 'ok' | 'warn' | 'alert'

function toneOf(percent: number): Tone {
  if (percent >= ALERT_AT) return 'alert'
  if (percent >= WARN_AT) return 'warn'
  return 'ok'
}

/** Text color for a figure: colored only when it needs attention. */
export function textColor(percent: number): 'warning' | 'error' | undefined {
  const tone = toneOf(percent)
  return tone === 'alert' ? 'error' : tone === 'warn' ? 'warning' : undefined
}

// Drawn as images, so these cannot read the app's theme: a neutral fill that
// reads on dark and light, amber and red only as signals, one brand orange.
const FILL: Record<Tone, string> = { ok: '#9aa3ae', warn: '#d9a441', alert: '#e5604c' }
const CLAUDE = '#D97757'
const INK = '#1b1a19'
const STILL = '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'

/**
 * A thin meter. It is still: the row redraws on every tool call, and a meter
 * that animated in would restart each time and flicker. Only a nearly spent
 * one moves, with a slow pulse.
 */
export function barSvg(percent: number, width: number): string {
  const p = Math.max(0, Math.min(100, percent))
  const fill = p === 0 ? 0 : Math.max(4, Math.round((p / 100) * width))
  const tone = toneOf(p)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">` +
    `<style>${tone === 'alert' ? '.f{animation:pulse 1.4s ease-in-out infinite}@keyframes pulse{50%{opacity:.55}}' : ''}${STILL}</style>` +
    `<rect width="${width}" height="6" rx="3" fill="#808080" fill-opacity=".26"/>` +
    `<rect class="f" width="${fill}" height="6" rx="3" fill="${FILL[tone]}"/></svg>`
  )
}

export type Mood = 'awake' | 'asleep' | 'worried' | 'alarmed'

/** How the character feels about an account: asleep unless in use, then by its busiest window. */
export function moodOf(a: AccountUsage, isInUse: boolean, t: number): Mood {
  if (!isInUse) return 'asleep'
  const top = busiest(a, t)
  const tone = toneOf(top ? effectivePercent(top, t) : 0)
  return tone === 'alert' ? 'alarmed' : tone === 'warn' ? 'worried' : 'awake'
}

/** What Claude is doing right now, as the character acts it out. */
export function activityOf(tool: string): Activity {
  if (/^(Bash|BashOutput|KillShell)$/.test(tool) || /terminal/i.test(tool)) return 'running'
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(tool)) return 'reading'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'writing'
  if (/^(WebSearch|WebFetch)$/.test(tool) || /browser|chrome|navigate|fetch|search/i.test(tool)) return 'browsing'
  if (/^(Agent|Task|Workflow|SendMessage)$/.test(tool)) return 'delegating'
  return 'thinking'
}

/** A pose: what it is doing, and how it feels about the usage. */
export type Pose = { activity: Activity; mood: Mood }


// Every move the character has. An element with one of these classes carries
// no transform attribute of its own (CSS would replace it).
const CREATURE_CSS =
  '.breathe,.snooze,.sway,.jump{transform-box:fill-box;transform-origin:50% 100%}' +
  '.breathe{animation:breathe 3.2s ease-in-out infinite}.snooze{animation:breathe 5.5s ease-in-out infinite}@keyframes breathe{50%{transform:scale(1.025,.965)}}' +
  '.sway{animation:sway 2.4s ease-in-out infinite}@keyframes sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}' +
  '.trot{animation:trot .36s ease-in-out infinite}@keyframes trot{50%{transform:translateY(-2px)}}' +
  '.jump{animation:jump .95s cubic-bezier(.3,0,.3,1) infinite}@keyframes jump{0%,100%{transform:translateY(0) scale(1.07,.9)}40%{transform:translateY(-8px) scale(.95,1.06)}72%{transform:translateY(0) scale(1.04,.95)}}' +
  '.shake{animation:shake .4s linear infinite}@keyframes shake{25%{transform:translateX(-1.2px)}75%{transform:translateX(1.2px)}}' +
  '.blink{transform-box:fill-box;transform-origin:center;animation:blink 4.4s infinite}@keyframes blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}' +
  '.glance{animation:glance 7s ease-in-out infinite}@keyframes glance{0%,40%,100%{transform:translateX(0)}50%,60%{transform:translateX(2px)}75%,85%{transform:translateX(-2px)}}' +
  '.up{transform:translateY(-2.5px)}' +
  '.scan{animation:scan 1.4s ease-in-out infinite alternate}@keyframes scan{from{transform:translate(-2px,2.5px)}to{transform:translate(2px,2.5px)}}' +
  '.dot{animation:dot 1.2s ease-in-out infinite}@keyframes dot{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-3px);opacity:1}}' +
  '.step{animation:step .36s ease-in-out infinite}@keyframes step{50%{transform:translateY(-3.5px)}}' +
  '.dash{opacity:0;animation:dash .55s linear infinite}@keyframes dash{0%{transform:translateX(6px);opacity:0}30%{opacity:.75}100%{transform:translateX(-7px);opacity:0}}' +
  '.scribble{transform-box:fill-box;transform-origin:30% 20%;animation:scribble .45s ease-in-out infinite alternate}@keyframes scribble{from{transform:rotate(-7deg)}to{transform:rotate(9deg)}}' +
  '.ink{stroke-dasharray:16;animation:ink 1.6s ease-out infinite}@keyframes ink{0%{stroke-dashoffset:16}70%,100%{stroke-dashoffset:0}}' +
  '.float{animation:float 2.2s ease-in-out infinite}@keyframes float{50%{transform:translateY(-3px)}}' +
  '.turn{transform-box:fill-box;transform-origin:center;animation:turn 1.8s ease-in-out infinite alternate}@keyframes turn{from{transform:scaleX(1)}to{transform:scaleX(.15)}}' +
  '.hop{animation:hop .7s ease-in-out infinite}@keyframes hop{50%{transform:translateY(-4px)}}' +
  '.spark{transform-box:fill-box;transform-origin:center;animation:spark 1.1s ease-out infinite}@keyframes spark{0%{transform:scale(0);opacity:0}40%{transform:scale(1);opacity:1}100%{transform:scale(.3);opacity:0}}' +
  '.z{opacity:0;animation:z 3s ease-out infinite}@keyframes z{15%{opacity:.9}100%{opacity:0;transform:translate(5px,-12px)}}' +
  '.drop{opacity:0;animation:drop 1.7s ease-in infinite}@keyframes drop{15%{opacity:1}100%{opacity:0;transform:translateY(11px)}}' +
  '.bang{animation:bang .6s steps(2) infinite}@keyframes bang{50%{opacity:.25}}' +
  // Hovering it (where the surface lets a drawing feel the pointer) gets a wave.
  '.arm{transform-box:fill-box;transform-origin:25% 85%}svg:hover .arm{animation:wave .45s ease-in-out infinite alternate}@keyframes wave{from{transform:rotate(-15deg)}to{transform:rotate(-60deg)}}'

/**
 * The character, in a 64 by 56 box (things above its head reach to y = -9):
 * the blocky orange mascot (a wide body, two tall eyes, an arm on each side,
 * four short legs), drawn as clean shapes so it can move smoothly. It has no
 * mouth: its eyes and what it holds say everything.
 */
function creature(pose: Pose): string {
  const isAsleep = pose.mood === 'asleep'
  const act: Activity = isAsleep ? 'idle' : pose.activity
  const isAlarmed = pose.mood === 'alarmed'
  const block = (x: number, y: number, w: number, h: number, extra = '') =>
    `<rect${extra} x="${x}" y="${y}" width="${w}" height="${h}" rx="1.2" fill="${CLAUDE}"/>`

  const eye = (x: number) =>
    isAsleep
      ? `<rect x="${x - 0.5}" y="19" width="6" height="2" rx="1" fill="${INK}"/>`
      : act === 'done'
        ? `<path d="M${x - 0.5} 20.5l3-4 3 4" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<rect class="blink" x="${x}" y="${isAlarmed ? 11 : 13}" width="5" height="${isAlarmed ? 13 : 10}" rx="1" fill="${INK}"/>`
  const look = isAsleep ? '' : act === 'thinking' ? 'up' : act === 'reading' ? 'scan' : act === 'idle' ? 'glance' : ''

  const legs = [14.5, 24.5, 34.5, 44.5]
    .map((x, i) =>
      block(x, 37, 5, 11, act === 'running' ? ` class="step" style="animation-delay:-${[0, 0.18, 0.09, 0.27][i]}s"` : ''),
    )
    .join('')
  const pencil =
    act === 'writing'
      ? `<g class="scribble"><path d="M58 22l3.6 1.2-4.2 13.5-2.9 1.9-.7-3.100z" fill="#f2c94c"/><path d="M54.5 38.600l.7-3.1 2.2 1.200z" fill="${INK}"/></g>`
      : ''
  const body =
    legs +
    block(4.5, 18, 6, 10) +
    `<g class="arm">${block(53.5, 18, 6, 10)}</g>` +
    block(9.5, 8, 45, 30) +
    `<g${look ? ` class="${look}"` : ''}>${eye(19.5)}${eye(39.5)}</g>` +
    pencil

  const move = isAsleep
    ? 'snooze'
    : act === 'done'
      ? 'jump'
      : act === 'running'
        ? 'trot'
        : act === 'thinking' || act === 'delegating'
          ? 'sway'
          : 'breathe'

  const star = (x: number, y: number, delay: number, fill: string) =>
    `<path class="spark" style="animation-delay:-${delay}s" d="M${x} ${y - 4}l1.2 2.8 2.8 1.2-2.8 1.2-1.2 2.8-1.2-2.8-2.8-1.2 2.8-1.200z" fill="${fill}"/>`
  // A helper is the same mascot, small.
  const helper = (x: number, delay: number) =>
    `<g class="hop" style="animation-delay:-${delay}s"><rect x="${x - 5}" y="41" width="10" height="7" rx=".8" fill="${CLAUDE}"/>` +
    `<rect x="${x - 3.5}" y="48" width="1.5" height="2.5" fill="${CLAUDE}"/><rect x="${x + 2}" y="48" width="1.5" height="2.5" fill="${CLAUDE}"/>` +
    `<rect x="${x - 2.8}" y="42.5" width="1.3" height="2.6" fill="${INK}"/><rect x="${x + 1.5}" y="42.5" width="1.3" height="2.6" fill="${INK}"/></g>`
  const props: Record<Activity, string> = {
    idle: '',
    thinking: [24, 32, 40]
      .map((x, i) => `<circle class="dot" style="animation-delay:-${0.9 - i * 0.2}s" cx="${x}" cy="0" r="2.2" fill="#f4efe6"/>`)
      .join(''),
    reading:
      `<g class="float"><rect x="19" y="33" width="26" height="15" rx="2" fill="#f4efe6"/>` +
      `<path d="M32 34.500v12M22.5 37.500h6.500M22.5 41h6.500M35 37.500h6.500M35 41h6.5" stroke="#b5ab9a" stroke-width="1.2" stroke-linecap="round"/></g>`,
    writing: `<path class="ink" d="M46 52.500h16" fill="none" stroke="#f4efe6" stroke-width="1.8" stroke-linecap="round"/>`,
    running: [14, 22, 30]
      .map((y, i) => `<path class="dash" style="animation-delay:-${i * 0.18}s" d="M-3 ${y}h7" stroke="#f4efe6" stroke-width="1.8" stroke-linecap="round"/>`)
      .join(''),
    browsing:
      `<g class="float"><circle cx="58" cy="1" r="6" fill="#8fc4f0"/><g class="turn"><ellipse cx="58" cy="1" rx="2.8" ry="6" fill="none" stroke="#3d6f9e" stroke-width="1"/></g>` +
      `<path d="M52 1h12" stroke="#3d6f9e" stroke-width="1"/></g>`,
    delegating: helper(2, 0) + helper(62, 0.35),
    done: star(6, 6, 0, '#f2c94c') + star(58, 2, 0.4, '#f4efe6') + star(62, 24, 0.75, '#f2c94c'),
  }
  const feeling = isAsleep
    ? [0, 1, 2]
        .map(
          i =>
            `<text class="z" style="animation-delay:-${i}s" x="${52 + i * 5}" y="${6 - i * 4}" font-family="ui-monospace,monospace" font-size="${8 + i * 1.5}" font-weight="700" fill="#c9d2e3">z</text>`,
        )
        .join('')
    : isAlarmed
      ? `<g class="bang"><rect x="30.5" y="-9" width="3" height="8" rx="1" fill="#e5604c"/><rect x="30.5" y="1" width="3" height="3" rx="1" fill="#e5604c"/></g>`
      : pose.mood === 'worried'
        ? `<path class="drop" d="M57 2c2 3 3 4.5 3 6a3 3 0 0 1-6 0c0-1.5 1-3 3-6z" fill="#8fc4f0"/>`
        : ''

  return (
    `<g${isAlarmed ? ' class="shake"' : ''}>` +
    `<ellipse cx="32" cy="50.5" rx="21" ry="2.2" fill="#000" fill-opacity=".28"/>` +
    `<g class="${move}">${body}</g>${isAsleep ? '' : props[act]}${feeling}</g>`
  )
}

/** The character alone, small, for the row. */
export function miniCharacterSvg(pose: Pose): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="26" viewBox="-4 -9 72 62">` +
    `<style>${CREATURE_CSS}${STILL}</style>${creature(pose)}</svg>`
  )
}

const SCENE: Record<Mood, { a: string; b: string; glow: number; speed: number }> = {
  awake: { a: CLAUDE, b: '#f0b392', glow: 0.5, speed: 1 },
  asleep: { a: '#5b6b86', b: '#3d4a63', glow: 0.4, speed: 1.8 },
  worried: { a: '#d9a441', b: CLAUDE, glow: 0.55, speed: 0.7 },
  alarmed: { a: '#e5604c', b: '#d9a441', glow: 0.65, speed: 0.4 },
}

/**
 * A small tile: the character over a slowly drifting glow. On the account in
 * use it acts out what Claude is doing; on the other it sleeps; and it grows
 * uneasy as the limits run down.
 */
export function sceneSvg(pose: Pose): string {
  const c = SCENE[pose.mood]
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="104" height="60" viewBox="0 0 104 60">` +
    `<defs><clipPath id="c"><rect width="104" height="60" rx="10"/></clipPath><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="11"/></filter></defs>` +
    `<style>${CREATURE_CSS}` +
    `.g1{animation:g1 ${11 * c.speed}s ease-in-out infinite alternate}@keyframes g1{to{transform:translate(30px,10px)}}` +
    `.g2{animation:g2 ${14 * c.speed}s ease-in-out infinite alternate}@keyframes g2{to{transform:translate(-34px,-8px)}}` +
    `${STILL}</style>` +
    `<g clip-path="url(#c)"><rect width="104" height="60" fill="${INK}"/>` +
    `<circle class="g1" cx="22" cy="14" r="24" fill="${c.a}" fill-opacity="${c.glow}" filter="url(#b)"/>` +
    `<circle class="g2" cx="88" cy="50" r="22" fill="${c.b}" fill-opacity="${c.glow * 0.8}" filter="url(#b)"/>` +
    `<g transform="translate(30 13) scale(.68)">${creature(pose)}</g></g></svg>`
  )
}

const DOING: Record<Activity, string> = {
  idle: 'resting',
  thinking: 'thinking',
  reading: 'reading',
  writing: 'writing',
  running: 'running a command',
  browsing: 'looking something up',
  delegating: 'working with helpers',
  done: 'celebrating a finished turn',
}

export function poseAlt(pose: Pose): string {
  if (pose.mood === 'asleep') return 'The character is asleep: this account is not in use'
  const feeling = pose.mood === 'alarmed' ? ', alarmed: the account is almost used up' : pose.mood === 'worried' ? ', worried: the account is running low' : ''
  return `The character is ${DOING[pose.activity]}${feeling}`
}
