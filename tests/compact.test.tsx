import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunResult, On, SessionMessage } from 'claude-code'

const SID = '74c05169-aaaa-bbbb-cccc-000000000000'
const MAILBOX = 'X:/box'
const MAIL = `${MAILBOX}/74c05169.txt`
const PEER = 'local_0000aaaa'
const OPTS = { options: { mailbox: MAILBOX, squeezeFrom: PEER } } as const

const BAND = {
  plugin: 'smart-compact',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const SAVE_ANSWER = 'Готово.\n\nСОХРАНЁНКА:\n- первый шаг: открыть ТИКЕТЫ.md'
const HISTORY: SessionMessage[] = [{ role: 'user', text: 'история', toolUses: [] }]
const MIN = 60_000
/** The kit hands paths over in the platform's own form; the test keys them with '/'. */
const norm = (p: string): string => p.replace(/\\/g, '/')

type World = {
  toasts: string[]
  submitted: { text: string; origin: unknown }[]
  compactions: (string | undefined)[]
  tokens: { now: number }
  config: { text: string }
  files: Map<string, { text: string; mtime: number }>
  store: Map<string, unknown>
  queue: { args: string; resolve: (r: CommandRunResult) => void }[]
  now: { ms: number }
  open: Set<string>
  home: { dir: string | undefined }
  placed: string[]
}

function engine(on: On): World {
  const w: World = {
    toasts: [],
    submitted: [],
    compactions: [],
    tokens: { now: 80_000 },
    config: { text: JSON.stringify({ mailbox: MAILBOX, squeezeFrom: PEER }) },
    files: new Map(),
    store: new Map(),
    queue: [],
    now: { ms: 0 },
    open: new Set(),
    home: { dir: undefined },
    placed: [],
  }
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? w.home.dir : undefined }))
  on('command.run', { command: 'compact' }, (_, e) => new Promise<CommandRunResult>(resolve => w.queue.push({ args: e.args, resolve })))
  on('fs.read', (_, e) => {
    if (/config\.json$/.test(e.path)) return { value: w.config.text }
    const f = w.files.get(norm(e.path))
    if (f === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: f.text }
  })
  /** A folder exists when some file lies under it. */
  const under = (p: string): string[] => {
    const dir = norm(p).replace(/\/+$/, '') + '/'
    return [...w.files.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length))
  }
  on('fs.exists', (_, e) => ({ value: w.files.has(norm(e.path)) || under(e.path).length > 0 }))
  on('fs.list', (_, e) => {
    const names = new Map<string, boolean>()
    for (const rest of under(e.path ?? '.')) {
      const [name, ...deeper] = rest.split('/')
      names.set(name, (names.get(name) ?? false) || deeper.length > 0)
    }
    return { value: [...names].map(([name, isDir]) => ({ name, kind: isDir ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false } as const)) }
  })
  on('fs.stat', (_, e) => {
    const f = w.files.get(norm(e.path))
    if (f === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtime, isLink: false } }
  })
  on('fs.write', (_, e) => {
    w.files.set(norm(e.path), { text: e.text, mtime: w.now.ms })
    return { value: undefined }
  })
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.id', () => ({ value: SID }))
  on('command.register', () => ({ value: { command: 'smart-compact' } }))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: w.tokens.now, window: 1_000_000, percent: 0 }, rateLimits: [] },
  }))
  on('session.compact', (_, e) => {
    w.compactions.push(e.instructions)
    return { messages: [{ role: 'user', text: 'пересказ', toolUses: [] }], tokensBefore: w.tokens.now, tokensAfter: 41_000 }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_, e) => {
    w.submitted.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.place', (_, e) => {
    w.placed.push(e.id)
    return { value: { isPlaced: true, requestId: `row-${e.id}` } }
  })
  on('ui.open', (_, e) => {
    w.open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    w.open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...w.open].map(id => ({ id, title: 'Сжатие с сохранёнкой', isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return w
}

async function idle($: Engine, w: World): Promise<void> {
  for (const q of w.queue.splice(0)) {
    const done = await $.session.compact({ trigger: 'manual', messages: HISTORY, instructions: q.args })
    q.resolve({ text: 'Compacted' })
  }
}

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const COMPOSER = { kind: 'composer' } as const

/** The СОХРАНЁНКА turn the mod's prompt starts, answered. */
async function saveTurn($: Engine, turnId: string, answer = SAVE_ANSWER): Promise<void> {
  await $.turn.start({ turnId, text: 'x [smart-compact] y' } as never)
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

test('band: the dot beside the button green, yellow from 200k, red from 400k; the number on the button', OPTS, async ($, on) => {
  const w = engine(on)
  await $.session.start(START)
  for (const [tokens, color] of [[80_000, 'success'], [180_000, 'success'], [250_000, 'warning'], [350_000, 'warning'], [450_000, 'error']] as const) {
    w.tokens.now = tokens
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: `t${tokens}`, reason: 'answer' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      const dot = await band.find({ type: 'Text', text: '●' })
      expect(dot).toBeDefined()
      expect((dot as { props?: { color?: string } }).props?.color ?? (dot as { color?: string }).color).toBe(color)
      expect(await band.find({ type: 'Button', text: `${Math.round(tokens / 1000)} тыс. · сжать` })).toBeDefined()
      await band.unmount()
    }
  }
})

test('one press: СОХРАНЁНКА prompt, then /compact; settled with counts', OPTS, async ($, on) => {
  const w = engine(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.tokens.now = 320_000
  await $.session.start(START)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'smart-compact' })
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]!.text).toContain('СОХРАНЁНКА:')
  expect(w.submitted[0]!.text).toContain('[smart-compact]')
  expect(await band.find({ type: 'Text', text: /^пишу сохранёнку…$/ })).toBeDefined()

  await saveTurn($, 't1')
  await clock.advance(2_000)
  expect(w.queue.length).toBe(1)
  await idle($, w)
  expect(w.compactions.length).toBe(1)
  expect(w.toasts.at(-1)).toContain('320 тыс. → пересказ 41 тыс.')
  expect(await band.find({ type: 'Button', text: '41 тыс. · сжать' })).toBeDefined()
  await band.unmount()
})

test('a second press while it runs does nothing; a typed message cancels', OPTS, async ($, on) => {
  const w = engine(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.tokens.now = 320_000
  await $.session.start(START)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'smart-compact' })
  expect(await band.find({ type: 'Button' })).toBeUndefined()
  expect(w.submitted.length).toBe(1)
  await $.prompt.submit({ text: 'нет, стой', wait: false, origin: COMPOSER })
  expect(w.toasts.at(-1)).toContain('отменено')
  // The СОХРАНЁНКА prompt that waited for idle is dropped when it finally enters.
  const late = await $.prompt.submit({ text: 'x [smart-compact] y', wait: false, origin: { kind: 'plugin', name: 'smart-compact', asUser: true } })
  expect(late.drop).toBe('сжатие уже отменено')
  await saveTurn($, 't1')
  await clock.advance(2_000)
  expect(w.queue.length).toBe(0)
  expect(await band.find({ type: 'Button', text: '320 тыс. · сжать' })).toBeDefined()
  await band.unmount()
})

test('no СОХРАНЁНКА in the answer, or a typed prompt in between: no compaction', OPTS, async ($, on) => {
  const w = engine(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.tokens.now = 320_000
  await $.session.start(START)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'smart-compact' })
  await saveTurn($, 't1', 'просто ответ')
  await clock.advance(2_000)
  expect(w.queue.length).toBe(0)

  await band.press({ key: 'smart-compact' })
  await $.prompt.submit({ text: 'стоп', wait: false, origin: COMPOSER })
  await saveTurn($, 't2')
  await clock.advance(2_000)
  expect(w.queue.length).toBe(0)
  await band.unmount()
})

test('mailbox «сожмись»: flow runs, outcome written back; stale request ignored', OPTS, async ($, on) => {
  const w = engine(on)
  const clock = mock.clock(on, { now: 100 * MIN })
  w.tokens.now = 250_000
  await $.session.start(START)

  w.files.set(MAIL, { text: 'сожмись\n', mtime: 100 * MIN })
  await clock.advance(MIN)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]!.text).toContain('Другой чат попросил')
  expect(w.files.get(MAIL)!.text).toContain('принято')
  await saveTurn($, 't1')
  await clock.advance(2_000)
  await idle($, w)
  expect(w.compactions.length).toBe(1)
  expect(w.files.get(MAIL)!.text).toMatch(/^сжато: 250 тыс\. → пересказ 41 тыс\./)

  // Not acted on twice; a request written long ago is refused.
  await clock.advance(MIN)
  expect(w.submitted.length).toBe(1)
  w.files.set(MAIL, { text: 'сожмись', mtime: 60 * MIN })
  await clock.advance(MIN)
  expect(w.submitted.length).toBe(1)
  expect(w.files.get(MAIL)!.text).toContain('старше')
})

test('peer «сожмись» from the set chat is consumed and starts the flow; others pass', OPTS, async ($, on) => {
  const w = engine(on)
  const clock = mock.clock(on, { now: 100 * MIN })
  w.tokens.now = 320_000
  await $.session.start(START)
  const fake = await $.prompt.submit({
    text: 'Another Claude session sent a message:\n<cross-session-message from="local_deadbeef" from-name="X">сожмись</cross-session-message>',
    wait: false,
    origin: { kind: 'peer' },
  })
  expect(fake.drop).toBeUndefined()
  const real = await $.prompt.submit({
    text: 'Another Claude session sent a message:\n<cross-session-message from="local_0000aaaa-1111-2222-3333-444455556666" from-name="Lead">\nсожмись\n</cross-session-message>',
    wait: false,
    origin: { kind: 'peer' },
  })
  expect(real.drop).toContain('smart-compact')
  await clock.advance(10)
  expect(w.submitted.filter(s => String(s.text).includes('[smart-compact]')).length).toBe(1)
})

test('auto: fat and quiet 47 min → flow; a tool call resets; guards kept in $.store', OPTS, async ($, on) => {
  const w = engine(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.tokens.now = 320_000
  await $.session.start(START)
  const answer = (id: string) => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' })

  await answer('a1')
  await clock.advance(30 * MIN)
  // @ts-ignore TS2589 in the kit's typings
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  await clock.advance(30 * MIN)
  expect(w.submitted.length).toBe(0)

  await answer('a2')
  await clock.advance(46 * MIN)
  expect(w.submitted.length).toBe(0)
  await clock.advance(1 * MIN + 1)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]!.text).toContain('Авто-сжатие')
  await saveTurn($, 's1')
  await clock.advance(2_000)
  await idle($, w)
  expect(w.compactions.length).toBe(1)
  const g = w.store.get(`guard:${SID}`) as { starts: number[]; lastCompactAt: number }
  expect(g.starts.length).toBe(1)
  expect(g.lastCompactAt).toBeGreaterThan(0)

  // Fat again at once: the gap (60 min) holds the next one back.
  w.tokens.now = 330_000
  await answer('a3')
  await clock.advance(51 * MIN)
  expect(w.submitted.length).toBe(1)
})

test('a chat with a mod of its own in dev-mods, any folder name: the machine-wide copy keeps out', OPTS, async ($, on) => {
  const w = engine(on)
  const clock = mock.clock(on, { now: 100 * MIN })
  w.tokens.now = 320_000
  w.home.dir = 'C:/Users/u/'
  w.files.set(`C:/Users/u/.claude/dev-mods/${SID}/lab-turn-tokens/.claude-plugin/plugin.json`, { text: '{}', mtime: 0 })
  await $.session.start(START)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'q1', reason: 'answer' })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  expect(await band.find({ type: 'Button', text: '320 тыс. · сжать' })).toBeUndefined()
  await band.unmount()

  const squeeze = await $.prompt.submit({
    text: '<cross-session-message from="local_0000aaaa-1111-2222-3333-444455556666" from-name="Lead">\nсожмись\n</cross-session-message>',
    wait: false,
    origin: { kind: 'peer' },
  })
  expect(squeeze.drop).toBeUndefined()
  w.files.set(MAIL, { text: 'сожмись', mtime: 100 * MIN })
  await clock.advance(120 * MIN)
  expect(w.submitted.filter(s => String(s.text).includes('[smart-compact]')).length).toBe(0)
  expect(w.files.get(MAIL)!.text).toBe('сожмись')
})

test('no mod of its own in dev-mods: the machine-wide copy works', OPTS, async ($, on) => {
  const w = engine(on)
  w.tokens.now = 320_000
  w.home.dir = 'C:/Users/u'
  w.files.set(`C:/Users/u/.claude/dev-mods/other-chat/smart-compact/.claude-plugin/plugin.json`, { text: '{}', mtime: 0 })
  // A stray file and a dot-folder in this chat's own folder are not mods.
  w.files.set(`C:/Users/u/.claude/dev-mods/${SID}/notes.txt`, { text: '', mtime: 0 })
  w.files.set(`C:/Users/u/.claude/dev-mods/${SID}/.cache/x`, { text: '', mtime: 0 })
  await $.session.start(START)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'q2', reason: 'answer' })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Button', text: '320 тыс. · сжать' })).toBeDefined()
  await band.unmount()
})

test('auto off in settings: never fires', { options: { ...OPTS.options, autoEnabled: false } }, async ($, on) => {
  const w = engine(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.tokens.now = 400_000
  await $.session.start(START)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer' })
  await clock.advance(120 * MIN)
  expect(w.submitted.length).toBe(0)
})

const PANE = {
  plugin: 'smart-compact',
  component: 'Pane',
  requestId: 'smart-compact',
  props: { title: 'Сжатие с сохранёнкой', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the small button opens and closes the panel; the panel switches auto for this chat', OPTS, async ($, on) => {
  const w = engine(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.tokens.now = 320_000
  await $.session.start(START)
  expect(w.open.size).toBe(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    await band.press({ key: 'smart-compact-pane' })
    expect(w.open.has('smart-compact')).toBe(true)
    await band.press({ key: 'smart-compact-pane' })
    expect(w.open.has('smart-compact')).toBe(false)
    await band.unmount()
  }
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Button', text: 'Выключить авто в этом чате' })).toBeDefined()
  // Each switch says what it means: someone who never read the README understands it.
  expect(await pane.find({ type: 'Text', text: '320 тыс.' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '█' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '░' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^жёлтый: 200–400 тыс\./ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '200 тыс. → 47 мин тишины → сжатие с сохранёнкой' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '● вкл' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'короткая · 1500 знаков' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'что чат сохранит себе при сжатии' })).toBeDefined()
  await pane.press({ key: 'smart-compact-auto' })
  expect(await pane.find({ type: 'Button', text: 'Включить авто в этом чате' })).toBeDefined()
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer' })
  await clock.advance(60 * MIN)
  expect(w.submitted.length).toBe(0)
  await pane.press({ key: 'smart-compact-auto' })
  expect(await pane.find({ type: 'Button', text: 'Выключить авто в этом чате' })).toBeDefined()
  await pane.unmount()
})

test('mode: обычный by default, the panel makes this chat расширенный', OPTS, async ($, on) => {
  const w = engine(on)
  mock.clock(on, { now: 1_000 })
  w.tokens.now = 320_000
  await $.session.start(START)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: '●' })).toBeDefined()
  await band.press({ key: 'smart-compact' })
  expect(w.submitted[0]!.text).toContain('1500')
  await $.prompt.submit({ text: 'стоп', wait: false, origin: COMPOSER })
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Button', text: 'Сделать подробной в этом чате' })).toBeDefined()
  await pane.press({ key: 'smart-compact-note' })
  expect(await pane.find({ type: 'Button', text: 'Сделать короткой в этом чате' })).toBeDefined()
  await pane.unmount()

  const again = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await again.press({ key: 'smart-compact' })
  expect(w.submitted.at(-1)!.text).toContain('5000')
  await again.unmount()
})

test('turn price: bars of the last answers on the band, the chat in the panel; subagents added to their answer', OPTS, async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000 })
  await $.session.start(START)
  const usage = (n: number, model = 'claude-opus-5-5') => ({ model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: n, cache_creation_input_tokens: 2000 })
  const empty = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await empty.find({ type: 'Text', text: /^ответ / })).toBeUndefined()
  await empty.unmount()
  // A Haiku 5.5 subagent (1 750 ХТ) joins the next answer (Opus: 50 000 ХТ).
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'a1', reason: 'answer', agentId: 'ag', usage: usage(100_000, 'claude-haiku-5-5') } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'm1', reason: 'answer', usage: usage(100_000) } as never)
  // A dear one: 4 830 000 ХТ, ≈0,4% of the week (no trailing zero).
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'm2', reason: 'answer', usage: usage(24_000_000) } as never)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: 'ответ ≈0,4% недели' })).toBeDefined()
  // A desktop: each bar a picture, one width, the height proportional (the cheap one 2 px, the dear one 16).
  const svg = (await band.find({ type: 'Svg' })) as { props?: { source?: string }; source?: string } | undefined
  expect(svg?.props?.source ?? svg?.source).toContain('y="14" width="6" height="2"')
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: '▁' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '█' })).toBeDefined()
  await term.unmount()
  // The pointer on a bar: the picture's own tooltip, over the bar's whole column.
  expect(svg?.props?.source ?? svg?.source).toContain('<title>ответ: ≈0,004% недели</title>')
  expect((svg as { props?: { isInteractive?: boolean } }).props?.isInteractive).toBe(true)
  await band.unmount()
  // Under the answer in the transcript: its price; another block draws as it was.
  const msg = (text: string) => $.ui.mount({ plugin: 'smart-compact', surface: 'desktop', component: 'AssistantMessage', requestId: `msg-${text}`, props: { text, isFirstOfReply: true } } as never)
  const closing = await msg('ok')
  expect(await closing.find({ type: 'Text', text: '≈0,4% недели' })).toBeDefined()
  await closing.unmount()
  const other = await msg('совсем другой текст')
  expect(await other.find({ type: 'Text', text: /недели/ })).toBeUndefined()
  await other.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'Чат ≈0,41% недели · кэш тёплый ещё 60 мин' })).toBeDefined()
  await pane.press({ key: 'smart-compact-cost' })
  await pane.unmount()
  const off = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await off.find({ type: 'Text', text: /^ответ / })).toBeUndefined()
  await off.unmount()
  const hidden = await msg('ok')
  expect(await hidden.find({ type: 'Text', text: /недели/ })).toBeUndefined()
  await hidden.unmount()
})
test('live bar: the running answer grows on the band with each request; no hover words in the band; «… · сжать» on the button', OPTS, async ($, on) => {
  const usage = (n: number) => ({ model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: n, cache_creation_input_tokens: 2000 })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: usage(1_000_000) } as never
  })
  const w = engine(on)
  mock.clock(on, { now: 1_000 })
  w.tokens.now = 250_000
  await $.session.start(START)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'm1', reason: 'answer', usage: usage(100_000) } as never)
  await $.turn.start({ turnId: 'm2', text: 'дальше' } as never)
  for (const index of [0, 1]) {
    for await (const _ of $.turn.step({ turnId: 'm2', index, model: 'claude-opus-5-5', messageCount: 3 } as never)) void _
  }
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /^идёт ответ ≈0,038% недели$/ })).toBeDefined()
  const bars = [] as string[]
  for (const el of (await band.findAll?.({ type: 'Svg' })) ?? [await band.find({ type: 'Svg' })]) {
    const x = el as { props?: { source?: string }; source?: string } | undefined
    bars.push(x?.props?.source ?? x?.source ?? '')
  }
  expect(bars.join('')).toContain('<title>идёт ответ: ≈0,038% недели</title>')
  expect(await band.find({ type: 'Button', text: '250 тыс. · сжать' })).toBeDefined()
  await band.unmount()
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'm2', reason: 'answer', usage: usage(2_000_000) } as never)
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /^идёт/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /^ответ ≈/ })).toBeDefined()
  await after.unmount()
})
