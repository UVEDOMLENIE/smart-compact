// What smart-compact keeps in $.state for the session.

/** The context window as $.session.usage() last reported it. */
export type Ctx = { tokens: number | null; window: number }

/** Who started a compaction: the band's button, another chat (squeeze word or mailbox), the idle timer. */
export type Who = 'button' | 'peer' | 'auto'

/**
 * One compaction at a time: idle -> asked (СОХРАНЁНКА prompt submitted) ->
 * writing (its turn runs) -> compacting (/compact queued) -> idle.
 */
export type Phase = 'idle' | 'asked' | 'writing' | 'compacting'

export type Req = {
  phase: Phase
  /** Clock time the request began; timers check it. */
  id: number
  /** The turn that writes the СОХРАНЁНКА, once it started. */
  turnId: string | null
  /** When the current phase began. */
  at: number
  /** `/compact` was queued; session.compact settles it. */
  isSent: boolean
  who: Who
  /** How the last request ended. */
  last: string | null
}

/** One answer's price in ХТ (its subagents' included) and the context before and after it. */
/** `tail`: the answer's last words, whitespace folded, to find its block in the transcript. */
export type TurnRow = { id: string; ht: number; before: number | null; after: number | null; tail?: string }

/** The answer still running: what its own requests cost so far, for the band's live bar. */
export type LiveTurn = { turnId: string; ht: number }

/** How much the save note holds: about 1500 signs, or up to about 5000 with every fact. */
export type NoteMode = 'обычный' | 'расширенный'

/** The plugin's userConfig (/config); missing or invalid fields fall back to defaults. */
export type CompactSettings = {
  autoEnabled: boolean
  thresholdTokens: number
  idleMinutes: number
  minGapMinutes: number
  maxPer6h: number
  /** Put the save note back after the compaction. Off only when another hook already does it. */
  returnNote: boolean
  /** The save note's size by default; the panel switches it per chat. */
  noteMode: NoteMode
  /** One quiet line in the panel: what the last answer cost. */
  showTurnCost: boolean
  /** ХТ in a week of the subscription, for the % of week. */
  weekHt: number
  /** The word another chat sends to squeeze this one. */
  squeezeWord: string
  /** The session whose squeeze message counts (its id, or its first part). Empty = off. */
  squeezeFrom: string
  /** Folder with squeeze files, one per chat: `<first 8 of session id>.txt`. Empty = off. */
  mailbox: string
}

/** The idle timer. */
export type Arm = {
  /** The armed timer's id; 0 when none. */
  armId: number
  seq: number
  /** When it is due (clock time), 0 when none. */
  dueAt: number
  /** Why the last timer started nothing. */
  note: string | null
}

/** `/smart-compact auto on|off` for this chat; wins over the setting. */
export type AutoOverride = 'on' | 'off' | null

declare module 'claude-code' {
  interface PluginState {
    'smart-compact': {
      ctx: Shaped<Ctx | null>
      req: Shaped<Req>
      cfg: Shaped<CompactSettings>
      arm: Shaped<Arm>
      autoOverride: AutoOverride
      noteOverride: NoteMode | null
      turns: Shaped<TurnRow[]>
      turnSeq: number
      agentHt: number
      live: Shaped<LiveTurn | null>
      chatHt: number
      warmAt: number
      isCostOff: boolean
      tick: number
      poll: number
    }
  }
}
