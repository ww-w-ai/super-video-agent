// Which fillText arguments are Reel.pictureText results, found without running the code: an identifier
// assigned from a Reel.pictureText(...) call, and a call to a function that only returns one. Everything
// else is left to the caller to report. Works on the token list of static-scan.mjs (tokens carry
// `close` for brackets and `open` for closing brackets) and makes a fixed number of passes over it.

const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const COMPOUND_OPERATORS = new Set(["+", "-", "*", "/", "%", "&", "|", "^"]);
const WORD_OPERATORS = new Set(["in", "instanceof", "of"]);
const ROOT = -1;

const isIdent = (token) => !!token && IDENT.test(token.value);

/** Index of the `)` closing a `Reel.pictureText(...)` call that starts at k and is the whole expression, else -1. */
function pictureTextCallEnd(tokens, k) {
  const v = (d) => tokens[k + d]?.value;
  if (v(0) !== "Reel" || v(1) !== "." || v(2) !== "pictureText" || v(3) !== "(") return -1;
  const close = tokens[k + 3].close;
  const next = tokens[close + 1]?.value;
  const endsExpression = next === undefined || [";", ",", ")", "}", "]"].includes(next) || (IDENT.test(next) && !WORD_OPERATORS.has(next));
  return endsExpression ? close : -1;
}

/** tokens[i] → index of the innermost `{` around it (ROOT outside any block). */
function enclosingBlocks(tokens) {
  const stack = [ROOT];
  return tokens.map((t, i) => {
    const here = stack.at(-1);
    if (t.value === "{") stack.push(i);
    else if (t.value === "}" && stack.length > 1) stack.pop();
    return here;
  });
}

/** Every `function` / arrow head: where its parameters and body are, and the name it is bound to (if any). */
function functionHeads(tokens) {
  const heads = [];
  const boundName = (k) => (tokens[k]?.value === "=" && isIdent(tokens[k - 1]) && tokens[k - 2]?.value !== "." ? tokens[k - 1].value : null);
  tokens.forEach((t, i) => {
    if (t.value === "function") {
      const named = isIdent(tokens[i + 1]) && tokens[i + 2]?.value === "(";
      const open = named ? i + 2 : i + 1;
      if (tokens[open]?.value !== "(") return;
      heads.push({ name: named ? tokens[i + 1].value : boundName(i - 1), open, body: tokens[open].close + 1 });
    } else if (t.value === "=" && tokens[i + 1]?.value === ">") {
      const lone = isIdent(tokens[i - 1]);
      const open = lone ? i - 1 : tokens[i - 1]?.open;
      if (open === undefined) return;
      heads.push({ name: boundName(open - 1), open, body: i + 2, arrow: true, lone });
    }
  });
  return heads;
}

/** name → block → true while every assignment to it in that block is a bare pictureText call. */
function collectAssignments(tokens, enclosing, heads) {
  const assigned = new Map();
  const mark = (name, block, pure) => {
    const byBlock = assigned.get(name) || new Map();
    byBlock.set(block, (byBlock.get(block) ?? true) && pure);
    assigned.set(name, byBlock);
  };
  tokens.forEach((t, j) => {
    if (!isIdent(t) || tokens[j - 1]?.value === ".") return;
    const op = tokens[j + 1]?.value;
    if (op === "=" && ![">", "="].includes(tokens[j + 2]?.value)) mark(t.value, enclosing[j], pictureTextCallEnd(tokens, j + 2) !== -1);
    else if (COMPOUND_OPERATORS.has(op) && tokens[j + 2]?.value === "=") mark(t.value, enclosing[j], false);
  });
  // A parameter shadows an outer name inside the function, so it is never a pictureText result.
  for (const h of heads) {
    if (tokens[h.body]?.value !== "{") continue;
    const params = h.lone ? [h.open] : paramTokens(tokens, h.open);
    for (const p of params) mark(tokens[p].value, h.body, false);
  }
  return assigned;
}

function paramTokens(tokens, open) {
  const out = [];
  for (let k = open + 1; k < tokens[open].close; k++) if (isIdent(tokens[k]) && ["(", ","].includes(tokens[k - 1].value)) out.push(k);
  return out;
}

/** Function name → true when it has at least one return and every return is a bare pictureText call. */
function collectPureFunctions(tokens, heads) {
  const verdict = new Map();
  const say = (name, pure) => name && verdict.set(name, (verdict.get(name) ?? true) && pure);
  const blocks = new Map();
  for (const h of heads) {
    if (h.arrow && tokens[h.body]?.value !== "{") say(h.name, pictureTextCallEnd(tokens, h.body) !== -1);
    else if (tokens[h.body]?.value === "{") blocks.set(h.body, { name: h.name, returns: 0, pure: true, close: tokens[h.body].close });
  }
  const open = [];
  tokens.forEach((t, i) => {
    if (blocks.has(i)) open.push(blocks.get(i));
    else if (t.value === "return" && open.length) {
      const fn = open.at(-1);
      fn.returns++;
      fn.pure &&= pictureTextCallEnd(tokens, i + 1) !== -1;
    }
    if (open.length && open.at(-1).close === i) {
      const fn = open.pop();
      say(fn.name, fn.returns > 0 && fn.pure);
    }
  });
  return verdict;
}

/**
 * @param {object[]} tokens token list of one source file
 * @returns {(i: number) => boolean} whether the fillText whose name token is tokens[i] draws a pictureText result
 */
export function pictureTextOrigins(tokens) {
  const enclosing = enclosingBlocks(tokens);
  const heads = functionHeads(tokens);
  const assigned = collectAssignments(tokens, enclosing, heads);
  const pureFunctions = collectPureFunctions(tokens, heads);

  const variableIsPictureText = (name, from) => {
    const byBlock = assigned.get(name);
    for (let block = enclosing[from]; byBlock; block = enclosing[block]) {
      if (byBlock.has(block)) return byBlock.get(block);
      if (block === ROOT) break;
    }
    return false;
  };

  return (i) => {
    const arg = tokens[i + 2];
    const end = tokens[i + 1].argEnd;
    if (!isIdent(arg)) return false;
    if (end === i + 3) return variableIsPictureText(arg.value, i);
    return tokens[i + 3]?.value === "(" && tokens[i + 3].close === end - 1 && pureFunctions.get(arg.value) === true;
  };
}
