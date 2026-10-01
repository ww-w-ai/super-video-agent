// Pure grouping of a dense window.__reel.issues() scan into contiguous
// runs (scripts/lib/browser.mjs's scanIssuesBySeek supplies the per-time
// issues; no browser needed here). review.mjs's normal Layout gate reads
// issues() at one frame per shot (its readAt) — qa.md "What the tools
// cannot see": a problem that only shows up mid-shot, during a move (e.g. a
// label sliding in from off-screen), is invisible to that. This groups a
// finer scan's hits into runs instead of one line per sample.

/**
 * @param {number[]} times seconds, non-decreasing
 * @param {Array[]} issuesByTime issues() result at each time (possibly empty)
 * @returns {{startSec:number, endSec:number, sampleCount:number, issueCount:number, types:string[], texts:string[]}[]}
 *   texts = the distinct `text` fields of the run's issues (which caption or label it is)
 */
export function groupIssueRuns(times, issuesByTime) {
  const runs = [];
  let i = 0;
  while (i < times.length) {
    const issues = issuesByTime[i];
    if (!issues || issues.length === 0) {
      i++;
      continue;
    }
    let j = i;
    let issueCount = 0;
    const types = new Set();
    const texts = new Set();
    while (j < times.length && issuesByTime[j] && issuesByTime[j].length > 0) {
      issueCount += issuesByTime[j].length;
      for (const iss of issuesByTime[j]) {
        types.add((iss && iss.type) || "unknown");
        if (iss && iss.text) texts.add(String(iss.text));
      }
      j++;
    }
    runs.push({
      startSec: times[i],
      endSec: times[j - 1],
      sampleCount: j - i,
      issueCount,
      types: Array.from(types),
      texts: Array.from(texts),
    });
    i = j;
  }
  return runs;
}
