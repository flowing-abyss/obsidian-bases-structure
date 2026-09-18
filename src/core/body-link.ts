// Pure string surgery: cuts the first non-embed wikilink whose target matches a linktext, plus
// enough of its surrounding line to keep the text readable. No Obsidian import — the applier
// resolves what "matches" means (a file's current linktext, plus its bare basename) and hands
// the resolved strings in.

const LINK_TOKEN = /\[\[([^[\]]+)\]\]/g;

/** A trimmed line holding nothing but an optional list marker — safe to drop entirely once its
 * only link is gone. */
const MARKER_ONLY_LINE = /^([-*+]|\d+\.)?$/;

export interface BodyLinkRemoval {
  /** The document text after the removal. */
  readonly text: string;
  /** Exactly what was cut out, for undo. */
  readonly removed: string;
  /** Where `removed` was cut from, in the original text. */
  readonly index: number;
}

/** `'folder/Child'` → `'Child'`; a bare name is returned as-is. */
function basenameOfLinktext(linktext: string): string {
  const lastSlash = linktext.lastIndexOf('/');
  return lastSlash === -1 ? linktext : linktext.slice(lastSlash + 1);
}

/** Whether `target` (already the part before `|`/`#`) names any of `linktexts` — trimmed,
 * case-insensitive, and matched against each entry's basename too (a mention can be shorter than
 * a resolved relative-path linktext). */
function targetMatches(target: string, linktexts: readonly string[]): boolean {
  const lower = target.trim().toLowerCase();
  return linktexts.some((entry) => {
    const trimmed = entry.trim().toLowerCase();
    return lower === trimmed || lower === basenameOfLinktext(trimmed).toLowerCase();
  });
}

/** The first `[[...]]` token whose target matches `linktexts` — an embed (`![[...]]`) or a
 * non-matching token is skipped, not returned. */
function findMatch(text: string, linktexts: readonly string[]): RegExpExecArray | null {
  LINK_TOKEN.lastIndex = 0;
  let match = LINK_TOKEN.exec(text);
  while (match !== null) {
    const isEmbed = text[match.index - 1] === '!';
    const target = (match[1] ?? '').split(/[|#]/)[0] ?? '';
    if (!isEmbed && targetMatches(target, linktexts)) {
      return match;
    }
    match = LINK_TOKEN.exec(text);
  }
  return null;
}

/** The bounds of the line containing `[start, end)`: `lineStart` right after the previous
 * newline (or 0), `lineEnd` right before the next one (or the end of the text). */
function lineBounds(
  text: string,
  start: number,
  end: number,
): { lineStart: number; lineEnd: number } {
  const lastNewline = text.lastIndexOf('\n', start - 1);
  const nextNewline = text.indexOf('\n', end);
  return {
    lineStart: lastNewline === -1 ? 0 : lastNewline + 1,
    lineEnd: nextNewline === -1 ? text.length : nextNewline,
  };
}

/** Cuts `[lineStart, lineEnd)` plus its trailing newline, when there is one — used once the
 * token's line holds nothing else worth keeping. */
function cutWholeLine(text: string, lineStart: number, lineEnd: number): BodyLinkRemoval {
  const cutEnd = lineEnd < text.length ? lineEnd + 1 : lineEnd;
  return {
    text: text.slice(0, lineStart) + text.slice(cutEnd),
    removed: text.slice(lineStart, cutEnd),
    index: lineStart,
  };
}

/** Cuts just the token, absorbing one adjacent space too when removing it would otherwise leave
 * a doubled-up space behind (a bare mention mid-sentence). */
function cutToken(text: string, tokenStart: number, tokenEnd: number): BodyLinkRemoval {
  const collapsesSpace = text[tokenStart - 1] === ' ' && text[tokenEnd] === ' ';
  const cutEnd = collapsesSpace ? tokenEnd + 1 : tokenEnd;
  return {
    text: text.slice(0, tokenStart) + text.slice(cutEnd),
    removed: text.slice(tokenStart, cutEnd),
    index: tokenStart,
  };
}

/** Removes the first non-embed wikilink whose target matches one of `linktexts`. Returns null
 * when there is none (an embed-only mention counts as none). */
export function removeBodyLink(text: string, linktexts: readonly string[]): BodyLinkRemoval | null {
  const match = findMatch(text, linktexts);
  if (match === null) {
    return null;
  }
  const tokenStart = match.index;
  const tokenEnd = tokenStart + match[0].length;
  const { lineStart, lineEnd } = lineBounds(text, tokenStart, tokenEnd);
  const lineWithoutToken = text.slice(lineStart, tokenStart) + text.slice(tokenEnd, lineEnd);
  return MARKER_ONLY_LINE.test(lineWithoutToken.trim())
    ? cutWholeLine(text, lineStart, lineEnd)
    : cutToken(text, tokenStart, tokenEnd);
}
