// smart-compact: compact a fat chat in time, and lose nothing.
//
// - Above the prompt: the chat's context as a number in a colour, and «Сжать».
//   One press: the chat writes its СОХРАНЁНКА (save note), then /compact is
//   queued; after the compaction the mod puts the note back, word for word.
//   While that runs the band says so; a message typed into the chat cancels it.
//   The number, «Сжать» and the panel's button sit at the right edge; the last
//   answers' prices as bars on the left. Green / yellow (200k) / red (400k).
//   The panel says what each switch means, for someone who never read the README.
// - Auto: a chat at or past the threshold (200k) that stays quiet after an
//   answer (47 min, while the prompt cache still lives). Not more than once
//   an hour, two per 6 h; the record lives in $.store.
// - Optional, off by default: a squeeze word from another chat (a peer
//   message from the session in settings), or a file in a mailbox folder.
//
// Settings: the manifest's userConfig (/config). Observe-only towards tools
// and prompts, except the squeeze message, consumed instead of reaching the model.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionCompactResult, SessionMessage, TurnUsage } from 'claude-code'

import type { Arm, AutoOverride, Ctx, NoteMode, Phase, Req, CompactSettings, TurnRow, Who } from '../types'

const PLUGIN = 'smart-compact'

const MINUTE = 60 * 1000
const SIX_HOURS = 6 * 60 * MINUTE
const POLL_MS = MINUTE
/** A «сожмись» file older than this when first seen is not acted on. */
const MAIL_STALE_MS = 30 * MINUTE
/** A squeeze from another chat is refused this soon after a compaction. */
const PEER_GAP_MS = 15 * MINUTE
const FIRST_DELAY_MS = 1000
/** Auto does not start this long after the chat's last model call: compacting takes 3–4 min, the cache lives 60. */
const LATEST_MS = 55 * MINUTE
/** A request older than this is not resumed after a reload. */
const STALE_MS = 10 * MINUTE

const DEFAULTS: CompactSettings = {
  autoEnabled: true,
  thresholdTokens: 200_000,
  idleMinutes: 47,
  minGapMinutes: 60,
  maxPer6h: 2,
  returnNote: true,
  noteMode: 'обычный',
  showTurnCost: true,
  weekHt: 1_200_000_000,
  squeezeWord: 'сожмись',
  // Empty = that path is off.
  squeezeFrom: '',
  mailbox: '',
}

const IDLE: Req = { phase: 'idle', id: 0, turnId: null, at: 0, isSent: false, who: 'button', last: null }
const NO_ARM: Arm = { armId: 0, seq: 0, dueAt: 0, note: null }

const ctx = atom({ plugin: 'smart-compact', key: 'ctx' } as const, null, { shape: 'ctx-1' })
const req = atom({ plugin: 'smart-compact', key: 'req' } as const, IDLE, { shape: 'req-1' })
const cfg = atom({ plugin: 'smart-compact', key: 'cfg' } as const, DEFAULTS, { shape: 'cfg-1' })
const arm = atom({ plugin: 'smart-compact', key: 'arm' } as const, NO_ARM, { shape: 'arm-1' })
const autoOverride = atom({ plugin: 'smart-compact', key: 'autoOverride' } as const, null as AutoOverride)
const noteOverride = atom({ plugin: 'smart-compact', key: 'noteOverride' } as const, null as NoteMode | null)
/** The last answers' prices, for the band's bars; subagents' turns added to the answer they belong to. */
const turns = atom({ plugin: 'smart-compact', key: 'turns' } as const, [] as TurnRow[], { shape: 'turns-1' })
const turnSeq = atom({ plugin: 'smart-compact', key: 'turnSeq' } as const, 0)
const agentHt = atom({ plugin: 'smart-compact', key: 'agentHt' } as const, 0)
/** The answer still running: what its own requests cost so far, for the band's live bar. */
const live = atom({ plugin: 'smart-compact', key: 'live' } as const, null, { shape: 'live-1' })
const chatHt = atom({ plugin: 'smart-compact', key: 'chatHt' } as const, 0)
/** When the chat last called the model: the cache lives an hour from then. */
const warmAt = atom({ plugin: 'smart-compact', key: 'warmAt' } as const, 0)
/** The turns' price on the band, off for this chat. */
const isCostOff = atom({ plugin: 'smart-compact', key: 'isCostOff' } as const, false)
/** Bumped once a minute, so the panel's minutes count down. */
const tick = atom({ plugin: 'smart-compact', key: 'tick' } as const, 0)
const poll = atom({ plugin: 'smart-compact', key: 'poll' } as const, 0)

// ---------------------------------------------------------------- texts

/** Marks the СОХРАНЁНКА prompt, so its turn is found at turn.start. */
const MARKER = '[smart-compact]'

const HEADS: Record<Who, (k: number) => string> = {
  button: () => `${MARKER} Человек нажал кнопку сжатия над полем ввода.`,
  peer: k => `${MARKER} Другой чат попросил этот чат сжаться: контекст ${k} тыс.`,
  auto: k => `${MARKER} Авто-сжатие: контекст ${k} тыс., чат долго стоит без дела.`,
}

const savePrompt = (head: string, isFull: boolean): string =>
  [
    head,
    'Этот чат сожмут командой /compact сразу после твоего ответа. Разговор заменится коротким пересказом, детали пропадут.',
    'Сделай только одно — напиши сохранёнку: то, что пересказ потеряет, а тебе понадобится дальше. После сжатия она вернётся к тебе слово в слово.',
    '— клади: первый шаг после сжатия; чего ждёшь и от кого; обещания и сроки; договорённости дословно; открытое — путём к файлу; важные мелочи, которые пересказ сгладит;',
    isFull
      ? '— режим «расширенный»: сохранёнка до ~5000 знаков, все факты, числа, решения, пути к файлам, номера и id, что сделано и что осталось — так, чтобы по ней одной можно было продолжить;'
      : '— не клади то, что уже есть в файлах проекта и инструкциях, и перечень сделанного; обычно хватает 1500 знаков;',
    '— незакрытое из прошлой сохранёнки перенеси или пометь закрытым.',
    'Сохранёнка — в самом конце ответа, первой её строкой отдельно «СОХРАНЁНКА:». Больше ничего не делай: без правок, команд и вопросов.',
  ].join('\n')

const COMPACT_SHORT =
  'Сохрани открытые задачи, обещания со сроками и пути к файлам. Сохранёнку из последнего ответа не пересказывай — она вернётся после сжатия сама. (smart-compact)'
const COMPACT_FULL =
  'Сохрани как можно больше фактов: решения, числа, пути к файлам, номера и id, открытые задачи и сроки. Сохранёнку из последнего ответа не пересказывай — она вернётся после сжатия сама. (smart-compact, расширенный)'
const isOurInstructions = (s: string | undefined): boolean => s !== undefined && [COMPACT_SHORT, COMPACT_FULL].includes(s.trim())

/** Where the save note starts in the answer. */
const SAVE_MARK = /^[ \t>*#_]*сохран[её]нка[ \t*_]*:/im

const NOTE_HEAD = 'Перед сжатием ты сам написал себе сохранёнку. Вот она, слово в слово.'

/** The save note from the last answer that has one: from its mark to the end. */
export function findNote(messages: readonly SessionMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m === undefined || m.role !== 'assistant') continue
    const at = m.text.search(SAVE_MARK)
    if (at >= 0) return m.text.slice(at).trim()
  }
  return null
}
/** Our own queued /compact, once its request was cancelled, is skipped so. */
const VETO = 'сжатие отменено (smart-compact)'

const WHO_WORDS: Record<Who, string> = { button: 'Сжатие', peer: 'Сжатие по просьбе другого чата', auto: 'Авто-сжатие' }

// ---------------------------------------------------------------- helpers

const thousands = (n: number): number => Math.round(n / 1000)

// ---------------------------------------------------------------- the cost of a turn (after the lab's lab-turn-tokens)

type Rates = readonly [number, number, number, number]

/**
 * ХТ per token — [input, output, cache read, cache write 1 h]; 1 ХТ = one
 * Haiku 4.5 input token ($1 per million). Claude API prices, checked 14.11.2026;
 * the first name the model id contains wins. Haiku 5.5 at
 * its rate for prompts up to 100k: a turn's sum does not tell one request's size.
 */
const PRICE: readonly (readonly [string, Rates])[] = [
  ['haiku-5', [0.1, 0.5, 0.01, 0.2]],
  ['haiku', [1, 5, 0.1, 2]],
  ['sonnet', [2, 10, 0.1, 4]],
  ['opus', [4, 20, 0.2, 8]],
  ['fable-5-2', [8, 40, 0.2, 16]],
  ['mythos-5-2', [8, 40, 0.2, 16]],
  ['fable', [10, 50, 0.25, 20]],
  ['mythos', [10, 50, 0.25, 20]],
]
const OPUS: Rates = [4, 20, 0.2, 8]

/** A turn's usage in ХТ, by the model its id names (unknown: as Opus). */
export function ht(u: TurnUsage): number {
  const m = u.model.toLowerCase()
  const [i, o, r, w] = PRICE.find(([name]) => m.includes(name))?.[1] ?? OPUS
  return u.input_tokens * i + u.output_tokens * o + u.cache_read_input_tokens * r + u.cache_creation_input_tokens * w
}

/**
 * ХТ as a share of the week: «≈0,012%»; null when the week's size is not set.
 * Three decimals below 0,1%: a compacted chat's answers differ there, and
 * rounded to two they all read «0,01%», as if the number stood still.
 */
export function weekShare(cost: number, weekHt: number): string | null {
  if (weekHt <= 0) return null
  const p = (cost / weekHt) * 100
  if (p < 0.001) return '<0,001%'
  // Trailing zeros are noise: «0,02», not «0,020».
  const n = p.toFixed(p < 0.1 ? 3 : p < 1 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, '')
  return `≈${n.replace('.', ',')}%`
}

const BARS = '▁▂▃▄▅▆▇█'
const BAR_COUNT = 12

/** Each answer's height against the dearest of the last ones: proportional, 0..1. */
function shares(rows: readonly TurnRow[]): number[] {
  const top = Math.max(1, ...rows.map(r => r.ht))
  return rows.map(r => r.ht / top)
}

/** The last answers as glyph bars, for the terminal; the newest is the right one. */
export function bars(rows: readonly TurnRow[]): string[] {
  return shares(rows.slice(-BAR_COUNT)).map(f => BARS[Math.min(7, Math.floor(f * 7.999))]!)
}

const BAR_W = 6
const BAR_GAP = 3
const BAR_H = 16
/** One grey for every bar, readable on a light and a dark theme alike. */
const BAR_FILL = '#9a9a9a'

/** A bar's column in pixels: the bar and the gap after it. */
export const BAR_STEP = BAR_W + BAR_GAP

/**
 * One bar as a picture, for a desktop: glyph bars drawn in its text font came
 * out of uneven width and baseline. Pixels: one width, one baseline, the height
 * proportional to the price (at least 2 px, so a cheap answer still shows).
 * One picture per bar, so the pointer on it can show that answer's price.
 */
export function barSvg(share: number, tip = ''): string {
  const h = Math.max(2, Math.round(Math.min(1, share) * BAR_H))
  const bar = `<rect x="0" y="${BAR_H - h}" width="${BAR_W}" height="${h}" rx="1" fill="${BAR_FILL}"/>`
  // The tooltip over the bar's whole column, not the bar alone: a 2 px bar is still easy to hit.
  const body = tip === '' ? bar : `<g><title>${xml(tip)}</title><rect x="0" y="0" width="${BAR_STEP}" height="${BAR_H}" fill="transparent"/>${bar}</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_STEP}" height="${BAR_H}" viewBox="0 0 ${BAR_STEP} ${BAR_H}">${body}</svg>`
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** What the pointer on a bar reads: «ответ: ≈0,048% недели · чат +12 тыс.». */
export const barTip = (row: TurnRow, weekHt: number): string => `${row.id === 'live' ? 'идёт ответ' : 'ответ'}: ${priceWords(row, weekHt)}`

/** The last answers' shares, for barSvg; the newest is the right one. */
export const barShares = (rows: readonly TurnRow[]): number[] => shares(rows.slice(-BAR_COUNT))

/** Beside the bars: «ответ ≈0,012% недели»; without the week's size, in ХТ. */
export function turnWords(row: TurnRow, weekHt: number): string {
  const share = weekShare(row.ht, weekHt)
  return share !== null ? `ответ ${share} недели` : `ответ ${Math.max(1, thousands(row.ht))} тыс. ХТ`
}

/** One answer's price in words, under it in the transcript and over the bars: «≈0,048% недели · чат +12 тыс.». */
export function priceWords(row: TurnRow, weekHt: number): string {
  const share = weekShare(row.ht, weekHt)
  const grew = row.before !== null && row.after !== null ? row.after - row.before : 0
  return [share !== null ? `${share} недели` : `${Math.max(1, thousands(row.ht))} тыс. ХТ`, grew >= 1000 ? `чат +${thousands(grew)} тыс.` : '']
    .filter(x => x !== '')
    .join(' · ')
}

const fold = (s: string): string => s.replace(/\s+/g, ' ').trim()
const TAIL = 80
/** Shorter than this, an answer is told apart from a block by the whole text, not its end. */
const SHORT = 40

/** The answer's last words, to know its block when the transcript draws it. */
export const tailOf = (answer: string): string => fold(answer).slice(-TAIL)

/** The answer a transcript block closes: its text ends with that answer's last words. */
export function rowOf(rows: readonly TurnRow[], text: string): TurnRow | undefined {
  const t = fold(text)
  if (t === '') return undefined
  return rows.findLast(r => r.tail !== undefined && r.tail !== '' && (r.tail.length < SHORT ? t === r.tail : t.endsWith(r.tail)))
}

/** The cache lives an hour from the chat's last model call. */
const CACHE_MS = 60 * MINUTE

/** In the panel: «Чат ≈1,2% недели · кэш тёплый ещё 23 мин». */
export function chatLine(chat: number, weekHt: number, warmAt: number, now: number): string {
  const left = Math.ceil((warmAt + CACHE_MS - now) / MINUTE)
  const cache = warmAt === 0 ? '' : left > 0 ? `кэш тёплый ещё ${left} мин` : 'кэш остыл'
  const share = weekShare(chat, weekHt)
  return [share !== null ? `Чат ${share} недели` : '', cache].filter(x => x !== '').join(' · ')
}

/**
 * The number's colour says what happens next. Green below 200k: auto leaves
 * the chat alone (~90k of any chat is its harness). Yellow 200–400k: auto
 * compacts it on the next pause. Red from 400k: every turn re-reads it all,
 * compacting pays off at once. A small window by how full it is (50%, 80%).
 */
export const LEVELS = ['success', 'warning', 'error'] as const
const YELLOW_AT = 200_000
const RED_AT = 400_000
/** What the colour means, under the number in the panel. */
const LEVEL_WORDS = [
  `зелёный: до ${YELLOW_AT / 1000} тыс. — сжимать незачем`,
  `жёлтый: ${YELLOW_AT / 1000}–${RED_AT / 1000} тыс. — авто сожмёт на паузе`,
  `красный: от ${RED_AT / 1000} тыс. — сожми сейчас`,
] as const

function level(c: Ctx | null): 0 | 1 | 2 | null {
  if (c === null || c.tokens === null) return null
  const tokens = c.tokens
  const bySize = tokens >= RED_AT ? 2 : tokens >= YELLOW_AT ? 1 : 0
  const share = c.window > 0 ? tokens / c.window : 0
  const byShare = share >= 0.8 ? 2 : share >= 0.5 ? 1 : 0
  return Math.max(bySize, byShare) as 0 | 1 | 2
}

export function shade(c: Ctx | null): string | undefined {
  const l = level(c)
  return l === null ? undefined : LEVELS[l]
}

/** The colour's meaning, in words. */
export function levelWords(c: Ctx | null): string | null {
  const l = level(c)
  return l === null ? null : LEVEL_WORDS[l]
}

const SCALE_CELLS = 20

/**
 * The panel's scale: 20 cells up to 500k (or the window), each in the colour of
 * its zone, lit up to the chat's size. The same zones as the number's colour.
 */
export function scaleCells(c: Ctx | null): { isOn: boolean; color: string }[] | null {
  if (c === null || c.tokens === null) return null
  const tokens = c.tokens
  const w = c.window > 0 ? c.window : Number.POSITIVE_INFINITY
  const yellow = Math.min(YELLOW_AT, 0.5 * w)
  const red = Math.min(RED_AT, 0.8 * w)
  const top = Math.min(RED_AT * 1.25, w)
  return Array.from({ length: SCALE_CELLS }, (_, i) => {
    const at = ((i + 0.5) / SCALE_CELLS) * top
    return { isOn: tokens >= at, color: LEVELS[at >= red ? 2 : at >= yellow ? 1 : 0] }
  })
}


function isPending(r: Req): boolean {
  return r.phase !== 'idle'
}

function clock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function refresh($: EngineInterface): Promise<void> {
  const { context } = await $.session.usage()
  await update($, ctx, () => ({ tokens: context.tokens ?? null, window: context.window }))
}

// ---------------------------------------------------------------- CompactSettings

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** The plugin's userConfig values (/config); a missing or odd value falls back to the default. */
export function parseSettings(o: Readonly<Record<string, unknown>>): CompactSettings {
  return {
    autoEnabled: typeof o.autoEnabled === 'boolean' ? o.autoEnabled : DEFAULTS.autoEnabled,
    thresholdTokens: num(o.thresholdTokens, 1_000, 10_000_000, DEFAULTS.thresholdTokens),
    idleMinutes: num(o.idleMinutes, 1, 24 * 60, DEFAULTS.idleMinutes),
    minGapMinutes: num(o.minGapMinutes, 1, 6 * 60, DEFAULTS.minGapMinutes),
    maxPer6h: Math.floor(num(o.maxPer6h, 1, 10, DEFAULTS.maxPer6h)),
    returnNote: typeof o.returnNote === 'boolean' ? o.returnNote : DEFAULTS.returnNote,
    noteMode: o.noteMode === 'расширенный' ? 'расширенный' : 'обычный',
    showTurnCost: typeof o.showTurnCost === 'boolean' ? o.showTurnCost : DEFAULTS.showTurnCost,
    weekHt: num(o.weekHt, 1_000_000, 1_000_000_000_000, DEFAULTS.weekHt),
    squeezeWord: str(o.squeezeWord) !== '' ? str(o.squeezeWord) : DEFAULTS.squeezeWord,
    squeezeFrom: str(o.squeezeFrom),
    mailbox: str(o.mailbox).replace(/[\\/]+$/, ''),
  }
}

/** Set by register from the options; a change in /config reloads the module. */
let SETTINGS: CompactSettings = DEFAULTS

async function loadSettings($: EngineInterface): Promise<CompactSettings> {
  await update($, cfg, () => SETTINGS)
  return SETTINGS
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** This chat's save note: its own switch first, else the setting. */
async function isFullNote($: EngineInterface): Promise<boolean> {
  const o = await read($, noteOverride)
  return (o ?? (await read($, cfg)).noteMode) === 'расширенный'
}

async function isAutoOn($: EngineInterface): Promise<boolean> {
  const o = await read($, autoOverride)
  if (o !== null) return o === 'on'
  return (await read($, cfg)).autoEnabled
}

// ---------------------------------------------------------------- guards ($.store, per chat)

type Guard = { starts: number[]; lastCompactAt: number }

async function guardKey($: EngineInterface): Promise<string> {
  return `guard:${await $.session.id()}`
}

async function readGuard($: EngineInterface): Promise<Guard> {
  const raw = (await $.store.get(await guardKey($))) as Partial<Guard> | undefined
  return {
    starts: Array.isArray(raw?.starts) ? raw.starts.filter((t): t is number => typeof t === 'number') : [],
    lastCompactAt: typeof raw?.lastCompactAt === 'number' ? raw.lastCompactAt : 0,
  }
}

async function writeGuard($: EngineInterface, g: Guard): Promise<void> {
  await $.store.set(await guardKey($), g)
}

// ---------------------------------------------------------------- mailbox

async function mailPath($: EngineInterface): Promise<string> {
  return `${(await read($, cfg)).mailbox}/${(await $.session.id()).slice(0, 8)}.txt`
}

/** Writes the outcome of a squeeze back into its file. */
async function mailReply($: EngineInterface, text: string): Promise<void> {
  try {
    if ((await read($, cfg)).mailbox === '') return
    await $.fs.write(await mailPath($), `${text} · ${clock(await $.clock.now())}\n`)
  } catch {}
}

async function checkMail($: EngineInterface): Promise<void> {
  if ((await read($, cfg)).mailbox === '') return
  const path = await mailPath($)
  let body: string
  let mtime: number
  try {
    if (!(await $.fs.exists(path))) return
    mtime = (await $.fs.stat(path)).mtimeMs
    body = await $.fs.read(path)
  } catch {
    return
  }
  if (!new RegExp(`^\\s*${escape((await read($, cfg)).squeezeWord)}(?!\\p{L})`, 'iu').test(body)) return
  const now = await $.clock.now()
  if (now - mtime > MAIL_STALE_MS) {
    await mailReply($, `не сжато: просьба старше ${MAIL_STALE_MS / MINUTE} мин, чат её увидел только сейчас`)
    return
  }
  await mailReply($, 'принято, чат пишет сохранёнку')
  const why = await peerRefusal($)
  if (why !== null) {
    await mailReply($, `не сжато: ${why}`)
    return
  }
  await begin($, 'peer')
}

async function peerRefusal($: EngineInterface): Promise<string | null> {
  if (isPending(await read($, req))) return 'уже идёт сжатие'
  const g = await readGuard($)
  const now = await $.clock.now()
  if (g.lastCompactAt > 0 && now - g.lastCompactAt < PEER_GAP_MS) return `сжимали меньше ${PEER_GAP_MS / MINUTE} мин назад`
  return null
}

/** A peer message that is nothing but the squeeze word, from the session in settings (`squeezeFrom`, or its first part). */
export function isSqueeze(text: string, squeezeFrom: string, word: string): boolean {
  if (squeezeFrom === '' || word === '') return false
  const m = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/i.exec(text)
  if (m === null) return false
  const attrs = m[1] ?? ''
  const from = /\bfrom-session="([^"]*)"/.exec(attrs)?.[1] ?? /\bfrom="([^"]*)"/.exec(attrs)?.[1] ?? ''
  if (!from.startsWith(squeezeFrom)) return false
  return new RegExp(`^\\s*${escape(word)}[.!]?\\s*$`, 'iu').test(m[2] ?? '')
}

// ---------------------------------------------------------------- the flow

async function finish($: EngineInterface, id: number, last: string): Promise<Req | null> {
  let was: Req | null = null
  await update($, req, r => {
    if (r.id !== id || r.phase === 'idle') return r
    was = r
    return { ...IDLE, id, who: r.who, last }
  })
  const ended = was as Req | null
  if (ended !== null && ended.who === 'peer') await mailReply($, last)
  return ended
}

async function cancelPending($: EngineInterface, why: string): Promise<void> {
  const r = await read($, req)
  if (r.phase === 'idle') return
  if ((await finish($, r.id, `отменено: ${why}`)) !== null) {
    $.ui.toast(`${WHO_WORDS[r.who]} отменено: ${why}.`, { timeoutMs: 6000 })
  }
}

/** Starts a request from idle: asks the chat for its СОХРАНЁНКА. */
async function begin($: EngineInterface, who: Who): Promise<boolean> {
  const id = await $.clock.now()
  let isMine = false
  await update($, req, (r): Req => {
    isMine = r.phase === 'idle'
    return isMine ? { ...IDLE, phase: 'asked', id, at: id, who, last: r.last } : r
  })
  if (!isMine) return false
  await disarm($)
  const c = await read($, ctx)
  const k = c?.tokens != null ? thousands(c.tokens) : 0
  $.ui.toast(`${WHO_WORDS[who]}: чат пишет сохранёнку, потом сожмётся. Напишешь сообщение в чат — отмена.`, {
    timeoutMs: 8000,
  })
  try {
    const sent = await $.prompt.submit({ text: savePrompt(HEADS[who](k), await isFullNote($)), asUser: true })
    if (sent.drop !== undefined) {
      await finish($, id, `не сжато: просьба о сохранёнке не ушла (${sent.drop})`)
      $.ui.toast(`${WHO_WORDS[who]}: просьба о сохранёнке не ушла — ${sent.drop}. Напиши что-нибудь в чат и нажми снова.`, {
        timeoutMs: 10000,
      })
    }
  } catch {
    await finish($, id, 'не сжато: просьба о сохранёнке не ушла')
    $.ui.toast(`${WHO_WORDS[who]}: просьба о сохранёнке не ушла.`, { timeoutMs: 8000 })
  }
  return true
}

function later($: EngineInterface, ms: number, run: () => Promise<unknown>): void {
  $.clock.after(ms, () => {
    void run().catch(() => undefined)
  })
}

/** Queues /compact as if typed; the engine runs it once the chat is idle. */
async function tryCompact($: EngineInterface, id: number): Promise<void> {
  let isMine = false
  const r = await update($, req, (x): Req => {
    isMine = x.phase === 'compacting' && x.id === id && !x.isSent
    return isMine ? { ...x, isSent: true } : x
  })
  if (!isMine) return
  try {
    await $.command.run({ command: 'compact', args: (await isFullNote($)) ? COMPACT_FULL : COMPACT_SHORT })
  } catch (err) {
    const why = err instanceof Error && err.message !== '' ? err.message : 'команда отклонена'
    if ((await finish($, id, `не сжато: ${why}`)) !== null) {
      $.ui.toast(`${WHO_WORDS[r.who]}: сжать не вышло (${why}). Сохранёнка написана — набери /compact сам.`, {
        timeoutMs: 10000,
      })
    }
    return
  }
  // Normally session.compact has ended it already.
  if ((await finish($, id, 'сжато')) !== null) $.ui.toast(`${WHO_WORDS[r.who]}: сжато с сохранёнкой.`, { timeoutMs: 8000 })
}

async function settle($: EngineInterface, r: Req, done: SessionCompactResult): Promise<void> {
  if (done.skip !== undefined) {
    if ((await finish($, r.id, `не сжато: ${done.skip}`)) !== null) {
      $.ui.toast(`${WHO_WORDS[r.who]} пропущено: ${done.skip}`, { timeoutMs: 8000 })
    }
    return
  }
  const b = done.tokensBefore
  const a = done.tokensAfter
  const cached = done.usage?.cache_read_input_tokens
  // How much of the chat the compaction read from the cache: the cheap part.
  const fromCache = cached !== undefined ? `, из кэша ${thousands(cached)} тыс.` : ''
  // `a` is the summary alone: the chat's own harness (~90k) comes on top of it.
  const words = b !== undefined && a !== undefined ? `${thousands(b)} тыс. → пересказ ${thousands(a)} тыс.${fromCache}` : `готово${fromCache}`
  if ((await finish($, r.id, `сжато: ${words}`)) !== null) {
    $.ui.toast(`${WHO_WORDS[r.who]}: сжато с сохранёнкой, ${words}`, { timeoutMs: 8000 })
  }
}

// ---------------------------------------------------------------- auto

async function disarm($: EngineInterface): Promise<void> {
  if ((await read($, arm)).armId === 0) return
  await update($, arm, a => ({ ...a, armId: 0, dueAt: 0 }))
}

function armTimer($: EngineInterface, armId: number, ms: number): void {
  later($, ms, () => autoFire($, armId))
}

async function maybeArm($: EngineInterface): Promise<void> {
  if (!(await isAutoOn($))) return
  const s = await read($, cfg)
  const c = await read($, ctx)
  if (c === null || c.tokens === null || c.tokens < s.thresholdTokens) return
  const now = await $.clock.now()
  const ms = s.idleMinutes * MINUTE
  const a = await update($, arm, x => ({ seq: x.seq + 1, armId: x.seq + 1, dueAt: now + ms, note: null }))
  armTimer($, a.armId, ms)
}

async function autoFire($: EngineInterface, armId: number): Promise<void> {
  if ((await read($, arm)).armId !== armId) return
  const skip = async (note: string): Promise<void> => {
    await update($, arm, x => (x.armId === armId ? { ...x, armId: 0, dueAt: 0, note } : x))
  }
  const s = await loadSettings($)
  if (!(await isAutoOn($))) return skip('авто выключено')
  if (isPending(await read($, req))) return skip('уже идёт сжатие')
  // Late (a sleeping computer, a long turn): past the 55th minute the cache may die mid-way.
  const warm = await read($, warmAt)
  if (warm > 0 && (await $.clock.now()) - warm > LATEST_MS) return skip('кэш уже остывает — сожмётся на следующей паузе')
  try {
    if ((await $.agent.list()).some(x => x.status === 'running' || x.status === 'pending')) return skip('в чате работает агент')
  } catch {}
  try {
    await refresh($)
  } catch {}
  const c = await read($, ctx)
  if (c === null || c.tokens === null || c.tokens < s.thresholdTokens) return skip('контекст ниже порога')
  const now = await $.clock.now()
  const g = await readGuard($)
  const recent = g.starts.filter(t => now - t < SIX_HOURS)
  const last = Math.max(g.lastCompactAt, ...recent, 0)
  if (last > 0 && now - last < s.minGapMinutes * MINUTE) return skip(`с прошлого сжатия меньше ${s.minGapMinutes} мин`)
  if (recent.length >= s.maxPer6h) return skip(`уже ${recent.length} за 6 ч — предел`)

  let isMine = false
  await update($, arm, x => {
    isMine = x.armId === armId
    return isMine ? { ...x, armId: 0, dueAt: 0, note: null } : x
  })
  if (!isMine) return
  // Counted now: one that later fails counts too.
  await writeGuard($, { ...g, starts: [...recent, now] })
  await begin($, 'auto')
}

/** One answer done: its price (with its subagents') for the band's bars, the cache clock. */
async function noteTurn($: EngineInterface, price: number, before: number | null, answer: string): Promise<void> {
  const extra = await read($, agentHt)
  await update($, agentHt, () => 0)
  const now = await $.clock.now()
  await update($, warmAt, () => now)
  const after = (await read($, ctx))?.tokens ?? null
  const n = await update($, turnSeq, x => x + 1)
  const row: TurnRow = { id: `turn-${n}`, ht: price + extra, before, after, tail: tailOf(answer) }
  await update($, turns, list => [...list, row].slice(-50))
  await update($, chatHt, t => t + row.ht)
}

/** Reads the mailbox once a minute; a newer poll (a reload) ends an older one. */
async function startPoll($: EngineInterface): Promise<void> {
  const mine = await update($, poll, n => n + 1)
  const timer = $.clock.every(POLL_MS, () => {
    void (async () => {
      if ((await read($, poll)) !== mine) {
        timer.cancel()
        return
      }
      await loadSettings($)
      await update($, tick, n => n + 1)
      await checkMail($)
    })().catch(() => undefined)
  })
}

// ---------------------------------------------------------------- hooks

const PANE = 'smart-compact'
const PANE_TITLE = 'Сжатие с сохранёнкой'
/** «a panel on the right»: the small button beside the number. */
const PANE_ICON = '◨'
/** The panel's cards but the size's: one accent frame, the app's own orange. */
const CARD_COLOR = 'claude'

async function togglePane($: EngineInterface): Promise<void> {
  const isUp = (await $.ui.panes()).some(p => p.id === PANE)
  if (isUp) await $.ui.close({ id: PANE })
  else await $.ui.open({ id: PANE, title: PANE_TITLE })
}

async function setAuto($: EngineInterface, isOn: boolean): Promise<void> {
  await update($, autoOverride, () => (isOn ? 'on' : 'off') as AutoOverride)
  if (!isOn) await disarm($)
}

const STATUS_HELP = 'Авто на этот чат: /smart-compact auto on | /smart-compact auto off.'

// ---------------------------------------------------------------- one copy per chat

/**
 * The machine-wide copy keeps out of a chat that has any mod of its own in
 * `~/.claude/dev-mods/<session id>/`: a stand of this mod under any folder
 * name, a showcase that compacts too, or a lab experiment. Two compacting mods
 * in one chat would both draw a band and both squeeze. Until session.start has
 * looked, the mod does nothing. A module variable: a reload runs session.start
 * again and sets it anew.
 */
let isQuiet = true


async function hasOwnCopy($: EngineInterface): Promise<boolean> {
  if (/[\\/]dev-mods[\\/]/i.test($.plugin.root)) return false
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (home === undefined || home === '') return false
  const own = `${home.replace(/[\\/]+$/, '')}/.claude/dev-mods/${await $.session.id()}`
  if (!(await $.fs.exists(own))) return false
  // A mod is a folder (or a link to one); a stray file or a dot-folder is not.
  return (await $.fs.list(own)).some(f => !f.name.startsWith('.') && (f.kind === 'dir' || f.isLink))
}

export const register: Register = (on, options: PluginOptions) => {
  SETTINGS = parseSettings(options)
  on('session.start', async ($, e, next) => {
    try {
      isQuiet = await hasOwnCopy($)
    } catch {
      isQuiet = false
    }
    if (isQuiet) return next(e)
    try {
      await $.command.register({
        name: 'smart-compact',
        description: 'Сжатие с сохранёнкой: что с этим чатом; /smart-compact auto on|off — авто-сжатие в этом чате',
        argumentHint: '[auto on|auto off]',
        immediate: true,
      })
    } catch {}
    try {
      await loadSettings($)
      await refresh($)
    } catch {}
    try {
      const r = await read($, req)
      const now = await $.clock.now()
      if (isPending(r) && now - r.at >= STALE_MS) await finish($, r.id, 'не сжато: мод перезапустился')
      else if (r.phase === 'compacting' && !r.isSent) later($, FIRST_DELAY_MS, () => tryCompact($, r.id))
    } catch {}
    try {
      await startPoll($)
      const a = await read($, arm)
      if (a.armId !== 0) armTimer($, a.armId, Math.max(FIRST_DELAY_MS, a.dueAt - (await $.clock.now())))
      later($, FIRST_DELAY_MS, () => checkMail($))
    } catch {}
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'smart-compact' }, async ($, e, next) => {
    if (isQuiet) return next(e)
    const [first = '', second = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (first === 'auto' || first === 'авто') {
      if (['off', 'выкл'].includes(second)) await setAuto($, false)
      else if (['on', 'вкл'].includes(second)) await setAuto($, true)
    }
    const s = await read($, cfg)
    const c = await read($, ctx)
    const r = await read($, req)
    const a = await read($, arm)
    const g = await readGuard($)
    const id8 = (await $.session.id()).slice(0, 8)
    const lines = [
      `Контекст: ${c?.tokens != null ? `${thousands(c.tokens)} тыс. из ${thousands(c.window)} тыс.` : 'ждём первый ответ'}.`,
      `Авто: ${(await isAutoOn($)) ? `вкл — с ${thousands(s.thresholdTokens)} тыс. после ${s.idleMinutes} мин тишины` : 'выкл'}${a.armId !== 0 ? `; таймер идёт, сработает в ${clock(a.dueAt)}` : ''}${a.note !== null ? `; последний раз не сжал: ${a.note}` : ''}.`,
      `Сжатий за 6 ч: ${g.starts.length}${g.lastCompactAt > 0 ? `, последнее ${clock(g.lastCompactAt)}` : ''}.`,
      `«${s.squeezeWord}» сообщением: ${s.squeezeFrom !== '' ? `от ${s.squeezeFrom}` : 'выкл (squeezeFrom не задан в /config)'}.`,
      `«${s.squeezeWord}» файлом: ${s.mailbox !== '' ? `${s.mailbox}/${id8}.txt` : 'выкл (mailbox не задан в /config)'}.`,
      r.last !== null ? `Последнее: ${r.last}.` : '',
      STATUS_HELP,
    ]
    return { text: lines.filter(l => l !== '').join('\n') }
  }).catch(() => ({ text: `smart-compact: не смог собрать статус. ${STATUS_HELP}` }))

  on('prompt.submit', async ($, e, next) => {
    if (isQuiet) return next(e)
    const kind = e.origin.kind
    if (kind === 'plugin' && e.origin.name === PLUGIN) {
      // Our СОХРАНЁНКА prompt waited for the chat to go idle; cancelled meanwhile, it is dropped.
      if (e.text.includes(MARKER) && (await read($, req)).phase !== 'asked') return { drop: 'сжатие уже отменено' }
      return next(e)
    }
    // Desktop's origin kind for another chat's message is not known yet: go by the frame.
    const isPeer = kind === 'peer' || kind === 'peer-send-message' || e.text.includes('<cross-session-message')
    if (isPeer) {
      const s = await read($, cfg)
      if (isSqueeze(e.text, s.squeezeFrom, s.squeezeWord)) {
        const why = await peerRefusal($)
        if (why === null) later($, 0, () => begin($, 'peer'))
        else $.ui.toast(`«${s.squeezeWord}» из другого чата: не сжимаю — ${why}.`, { timeoutMs: 8000 })
        return { drop: `smart-compact: «${s.squeezeWord}» принято модом` }
      }
    }
    await disarm($)
    const isPerson = kind === 'composer' || kind === 'bridge'
    if (isPerson && e.isMeta !== true && e.command?.name !== 'smart-compact') await cancelPending($, 'ты написал сообщение')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (isQuiet) return next(e)
    await disarm($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (isQuiet) return next(e)
    if (e.agentId === undefined) {
      await disarm($)
      await update($, live, () => ({ turnId: e.turnId, ht: 0 })).catch(() => undefined)
      if (e.text.includes(MARKER)) {
        const at = await $.clock.now()
        await update($, req, (r): Req => (r.phase === 'asked' ? { ...r, phase: 'writing', turnId: e.turnId, at } : r))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (isQuiet) return ran
    const price = e.usage === undefined ? 0 : ht(e.usage)
    if (e.agentId !== undefined) {
      // A subagent's turn: its price waits for the main answer it belongs to.
      if (price > 0) await update($, agentHt, n => n + price).catch(() => undefined)
      return ran
    }
    const before = (await read($, ctx))?.tokens ?? null
    try {
      await refresh($)
    } catch {}
    try {
      await noteTurn($, price, before, e.answer ?? '')
      await update($, live, () => null)
    } catch {}
    const r = await read($, req)
    if (r.phase !== 'writing' || r.turnId !== e.turnId) {
      if (r.phase === 'idle' && e.reason === 'answer') await maybeArm($)
      return ran
    }
    if (e.reason !== 'answer') {
      await finish($, r.id, 'отменено: ответ прервался')
      $.ui.toast(`${WHO_WORDS[r.who]}: ответ прервался — сжатие отменено.`, { timeoutMs: 6000 })
      return ran
    }
    if (!SAVE_MARK.test(e.answer)) {
      await finish($, r.id, 'не сжато: в ответе нет сохранёнки')
      $.ui.toast(`${WHO_WORDS[r.who]}: в ответе нет «СОХРАНЁНКА:» — сжимать не стал.`, { timeoutMs: 10000 })
      return ran
    }
    const at = await $.clock.now()
    await update($, req, (x): Req => (x.id === r.id && x.phase === 'writing' ? { ...x, phase: 'compacting', at, isSent: false } : x))
    later($, FIRST_DELAY_MS, () => tryCompact($, r.id))
    return ran
  }).catch(($, e, next) => next(e))

  // Each request of the running answer: its price, so the band's right bar grows while it works.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (isQuiet || e.agentId !== undefined || r.usage === null) return r
    const price = ht(r.usage)
    try {
      await update($, live, x => (x !== null && x.turnId === e.turnId ? { ...x, ht: x.ht + price } : { turnId: e.turnId, ht: price }))
    } catch {}
    return r
  })

  on('session.compact', async ($, e, next) => {
    if (isQuiet || e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const r = await read($, req)
    const isOurs = isOurInstructions(e.instructions)
    const isLive = r.phase === 'compacting' && r.isSent
    if (isOurs && !isLive) return { skip: VETO }

    const done = await next(e)
    try {
      if (done.skip === undefined) {
        const now = await $.clock.now()
        const g = await readGuard($)
        await writeGuard($, { ...g, lastCompactAt: now })
        const after = done.tokensAfter
        if (after !== undefined) await update($, ctx, c => (c === null ? c : { ...c, tokens: after }))
      }
      if (isOurs) await settle($, r, done)
      else if (isLive && done.skip === undefined) await finish($, r.id, 'чат уже сжат другим путём — второй раз не сжимаю')
    } catch {}
    // The save note back, word for word, unless the engine already kept that message.
    if (isOurs && isLive && done.skip === undefined && (await read($, cfg)).returnNote) {
      const note = findNote(e.messages)
      if (note !== null && !done.messages.some(m => m.text.includes(note))) {
        return { ...done, messages: [...done.messages, { role: 'user', text: `${NOTE_HEAD}\n\n${note}`, toolUses: [] }] }
      }
    }
    return done
  }).catch(($, e, next) => next(e))

  // Under the block that closes an answer in the transcript: what the answer cost. Only the
  // drawing changes; the stored message, and so the chat's context, stay as they were.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    if (isQuiet || e.props.isSummary === true) return drawn
    const s = await read($, cfg)
    if (!s.showTurnCost || (await read($, isCostOff))) return drawn
    const row = rowOf(await read($, turns), e.props.text)
    if (row === undefined) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        <Text dimColor>{priceWords(row, s.weekHt)}</Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // The one button above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isQuiet || e.props.hasSurvey) return next(e)
    const c = await read($, ctx)
    const r = await read($, req)
    const { Box, Text, Button } = $.ui.resolve(e)
    const phase: Phase = r.phase

    if (phase !== 'idle') {
      const what = phase === 'compacting' ? 'сжимаю' : 'пишу сохранёнку'
      return (
        <Box flexDirection="row" gap="sm">
          <Text color="warning">{what}…</Text>
        </Box>
      )
    }
    const label = c === null || c.tokens === null ? 'контекст …' : `${thousands(c.tokens)} тыс.`
    const s = await read($, cfg)
    // The answer still running joins as the right bar, growing with each of its requests.
    const now = await read($, live)
    const agents = await read($, agentHt)
    const running: TurnRow | null = now !== null && now.ht + agents > 0 ? { id: 'live', ht: now.ht + agents, before: null, after: null } : null
    const list = running === null ? await read($, turns) : [...(await read($, turns)), running]
    const last = list.at(-1)
    const isCost = s.showTurnCost && !(await read($, isCostOff)) && last !== undefined
    const words = last === undefined ? '' : running !== null ? `идёт ${turnWords(last, s.weekHt)}` : turnWords(last, s.weekHt)
    const rows = list.slice(-BAR_COUNT)
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    // The turns' bars on the left; the colour dot and «263 тыс. · сжать» and the panel's button
    // together at the right edge, next to the prompt's own buttons. A desktop draws a Button
    // natively, its label in one colour: the colour lives in the dot beside it.
    // The pointer on a bar: that answer's price, the picture's own tooltip (after arena-a4 0.0.5,
    // A4-F17: one interactive Svg per bar). A tooltip floats, so the band never moves.
    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" width="100%" gap="sm">
        <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={1}>
          {isCost && last !== undefined && (
            <Box flexDirection="row" alignItems="flex-end">
              {Svg !== undefined
                ? barShares(list).map((f, i) => {
                    const tip = barTip(rows[i]!, s.weekHt)
                    return <Svg key={`smart-compact-bar-${i}`} source={barSvg(f, tip)} alt={tip} width={BAR_STEP} height={BAR_H} isInteractive />
                  })
                : bars(list).map((ch, i) => <Text key={`smart-compact-bar-${i}`}>{ch}</Text>)}
            </Box>
          )}
          {isCost && last !== undefined && (
            <Box>
              <Text dimColor>{words}</Text>
            </Box>
          )}
        </Box>
        <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
          <Text color={shade(c)}>●</Text>
          <Button
            key="smart-compact"
            label={c === null || c.tokens === null ? 'сжать' : `${label} · сжать`}
            {...(level(c) === 2 ? { variant: 'primary' as const } : {})}
            onPress={() => void begin($, 'button')}
          />
          <Button key="smart-compact-pane" label={PANE_ICON} dimColor onPress={() => void togglePane($)} />
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // The panel the small button opens: what the mod does, each switch with a line on what it means.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (isQuiet) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = await read($, ctx)
    const s = await read($, cfg)
    const r = await read($, req)
    const a = await read($, arm)
    const o = await read($, autoOverride)
    const isAuto = o !== null ? o === 'on' : s.autoEnabled
    const isFull = await isFullNote($)
    await read($, tick)
    const chat = chatLine(await read($, chatHt), s.weekHt, await read($, warmAt), await $.clock.now())
    const isCost = s.showTurnCost && !(await read($, isCostOff))
    const colour = levelWords(c)
    const scale = scaleCells(c)
    const tone = shade(c)
    const k = thousands(s.thresholdTokens)
    const done = await read($, turns)
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    // Cards, not a wall of text: a frame per subject, its state up top in a word or a colour,
    // a chain of arrows for how it works, its button at the bottom. The size's frame takes the
    // size's colour; the others one accent, so the cards stand apart.
    return (
      <Box flexDirection="column" gap="sm">
        <Box flexDirection="column" borderStyle="round" {...(tone !== undefined ? { borderColor: tone } : { borderDimColor: true })} paddingX={1}>
          {c === null || c.tokens === null ? (
            <Text dimColor>цифры появятся после первого ответа</Text>
          ) : (
            <Text>
              <Text color={shade(c)} bold>
                {thousands(c.tokens)} тыс.
              </Text>
              <Text dimColor> из {thousands(c.window)} тыс.</Text>
            </Text>
          )}
          {scale !== null && (
            <Text>
              {scale.map((x, i) => (
                <Text key={`cell-${i}`} color={x.color} dimColor={!x.isOn}>
                  {x.isOn ? '█' : '░'}
                </Text>
              ))}
            </Text>
          )}
          {colour !== null && <Text dimColor>{colour}</Text>}
          {chat !== '' && <Text dimColor>{chat}</Text>}
          <Text dimColor>«Сжать» → сохранёнка → сжатие → сохранёнка вернётся</Text>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor={CARD_COLOR} paddingX={1}>
          <Text>
            <Text bold>Авто </Text>
            {isAuto ? <Text color="success">● вкл</Text> : <Text dimColor>○ выкл</Text>}
          </Text>
          <Text dimColor>
            {k} тыс. → {s.idleMinutes} мин тишины → сжатие с сохранёнкой
          </Text>
          <Text dimColor>раньше встроенного сжатия, пока кэш тёплый</Text>
          {isAuto && a.armId !== 0 && <Text color="warning">сожмётся в {clock(a.dueAt)}, если чат будет молчать</Text>}
          <Button
            key="smart-compact-auto"
            label={isAuto ? 'Выключить авто в этом чате' : 'Включить авто в этом чате'}
            onPress={() => void setAuto($, !isAuto)}
          />
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor={CARD_COLOR} paddingX={1}>
          <Text>
            <Text bold>Сохранёнка </Text>
            <Text dimColor>{isFull ? 'подробная · до 5000 знаков' : 'короткая · 1500 знаков'}</Text>
          </Text>
          <Text dimColor>что чат сохранит себе при сжатии</Text>
          <Text dimColor>{isFull ? 'подробная — для очень важных чатов и проектов' : 'подробная, до 5000 — для очень важных чатов и проектов'}</Text>
          <Button
            key="smart-compact-note"
            label={isFull ? 'Сделать короткой в этом чате' : 'Сделать подробной в этом чате'}
            onPress={() => void update($, noteOverride, () => (isFull ? 'обычный' : 'расширенный') as NoteMode)}
          />
        </Box>
        {s.showTurnCost && (
          <Box flexDirection="column" borderStyle="round" borderColor={CARD_COLOR} paddingX={1}>
            <Text>
              <Text bold>Цена ответа </Text>
              {Svg === undefined && bars(done).join('')}
            </Text>
            {Svg !== undefined && done.length > 0 && (
              <Box flexDirection="row" alignItems="flex-end">
                {barShares(done).map((f, i) => (
                  <Svg
                    key={`mini-${i}`}
                    source={barSvg(f, barTip(done.slice(-BAR_COUNT)[i]!, s.weekHt))}
                    alt={barTip(done.slice(-BAR_COUNT)[i]!, s.weekHt)}
                    width={BAR_STEP}
                    height={BAR_H}
                    isInteractive
                  />
                ))}
              </Box>
            )}
            <Text dimColor>столбик = ответ · выше = дороже</Text>
            <Text dimColor>наведи на столбик — его цена</Text>
            <Text dimColor>цена — и под каждым ответом в переписке</Text>
            <Button
              key="smart-compact-cost"
              label={isCost ? 'Скрыть цену ответа' : 'Показывать цену ответа'}
              dimColor
              onPress={() => void update($, isCostOff, v => !v)}
            />
          </Box>
        )}
        {r.last !== null && <Text dimColor>Последнее: {r.last.replace(/\.$/, '')}.</Text>}
      </Box>
    )
  }).catch(($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>smart-compact: панель не нарисовалась.</Text>
  })
}
