// One render opens the reel page as few times as it can. A 3D film's page
// takes minutes to open under load, and render.mjs used to open it once for
// the shot list, once per probe worker, once per render worker, once for the
// sound effects and once for the sound cues. The pool keeps every session it
// opened and hands an idle one back out; a new one is opened only when every
// open session is busy (a second --workers worker).

/**
 * @template S
 * @param {{open: () => Promise<S>, warm?: (session: S, shotIds: string[]) => Promise<void>, close?: (session: S) => Promise<void>}} deps
 *   open: opens a fresh session (openReel). warm: warms the given shots in a
 *   session (warmShotsOf). close: closes one (default session.close()).
 */
export function createSessionPool({ open, warm = async () => {}, close = (s) => s.close() }) {
  const idle = [];
  const all = new Set();
  let warmIds = [];
  let opened = 0;

  return {
    /** Sessions opened so far (the page-open count). */
    get opened() {
      return opened;
    },

    /** An idle session, or a newly opened one warmed for the current shot set. */
    async acquire() {
      if (idle.length) return idle.pop();
      const s = await open();
      opened++;
      all.add(s);
      if (warmIds.length) await warm(s, warmIds);
      return s;
    },

    /** Gives a session back for the next acquire(). */
    release(s) {
      if (all.has(s) && !idle.includes(s)) idle.push(s);
    },

    /** Closes a session that may be broken (a transport error); it is never handed out again. */
    async discard(s) {
      all.delete(s);
      const i = idle.indexOf(s);
      if (i !== -1) idle.splice(i, 1);
      await close(s).catch(() => {});
    },

    /**
     * Sets the shots the captures will need and warms them in every open
     * session; sessions opened later are warmed for the same shots.
     * @param {string[]} shotIds
     */
    async warmFor(shotIds) {
      warmIds = [...new Set([...warmIds, ...shotIds])];
      for (const s of all) await warm(s, warmIds);
    },

    /** Runs `fn` with a session and gives it back afterwards, also on failure. */
    async use(fn) {
      const s = await this.acquire();
      try {
        return await fn(s);
      } finally {
        this.release(s);
      }
    },

    async closeAll() {
      const list = [...all];
      all.clear();
      idle.length = 0;
      await Promise.all(list.map((s) => close(s).catch(() => {})));
    },
  };
}
