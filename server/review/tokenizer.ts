export type TokenKind = 'word' | 'string' | 'number' | 'punct' | 'comment' | 'variable';

export interface Token {
  kind: TokenKind;
  /** Normalized/transformed value: keywords preserve case, quoted identifiers lose quotes. */
  value: string;
  raw: string;
  start: number;
  end: number;
  line: number;
  column: number;
  depth: number;
  quoted: boolean;
}

const WORD_START = /[A-Za-z_\u0080-\uFFFF]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const DIGIT = /[0-9]/;

/**
 * MySQL only starts a `--` comment when the second dash is followed by
 * whitespace or a control character. `SELECT 1--2` is `1 - (-2)` for the
 * server, so a tokenizer that treats every `--` as a comment hides the rest of
 * the statement from the scope checker.
 */
function startsDashComment(sql: string, index: number): boolean {
  // `--` at the very end of the input is still a comment.
  if (index >= sql.length) return true;
  const ch = sql[index];
  if (ch === ' ') return true;
  const code = ch.charCodeAt(0);
  // Control characters (tab, newline, carriage return, …).
  return code < 0x20 || code === 0x7f;
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  let depth = 0;

  const advance = (count = 1): string => {
    let out = '';
    for (let n = 0; n < count && i < sql.length; n += 1) {
      const ch = sql[i];
      out += ch;
      i += 1;
      if (ch === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    return out;
  };

  const push = (
    kind: TokenKind,
    value: string,
    start: number,
    end: number,
    startLine: number,
    startColumn: number,
    tokenDepth: number,
    quoted = false,
  ): void => {
    tokens.push({
      kind,
      value,
      raw: sql.slice(start, end),
      start,
      end,
      line: startLine,
      column: startColumn,
      depth: tokenDepth,
      quoted,
    });
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Whitespace
    if (/\s/.test(ch)) {
      advance();
      continue;
    }

    const start = i;
    const startLine = line;
    const startColumn = column;

    // Line comments. `#` always starts one; `--` only when the second dash is
    // followed by whitespace or a control character, exactly as MySQL reads it.
    if (ch === '#' || (ch === '-' && next === '-' && startsDashComment(sql, i + 2))) {
      while (i < sql.length && sql[i] !== '\n') advance();
      push('comment', sql.slice(start, i), start, i, startLine, startColumn, depth);
      continue;
    }

    // Block comments
    if (ch === '/' && next === '*') {
      advance(2);
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) advance();
      if (i < sql.length) advance(2);
      push('comment', sql.slice(start, i), start, i, startLine, startColumn, depth);
      continue;
    }

    // Single-quoted / double-quoted strings
    if (ch === "'" || ch === '"') {
      const quote = ch;
      advance();
      let value = '';
      while (i < sql.length) {
        const current = sql[i];
        if (current === '\\' && i + 1 < sql.length) {
          advance();
          value += advance();
          continue;
        }
        if (current === quote) {
          if (sql[i + 1] === quote) {
            advance(2);
            value += quote;
            continue;
          }
          advance();
          break;
        }
        value += advance();
      }
      push('string', value, start, i, startLine, startColumn, depth);
      continue;
    }

    // Backtick-quoted identifier
    if (ch === '`') {
      advance();
      let value = '';
      while (i < sql.length) {
        if (sql[i] === '`') {
          if (sql[i + 1] === '`') {
            advance(2);
            value += '`';
            continue;
          }
          advance();
          break;
        }
        value += advance();
      }
      push('word', value, start, i, startLine, startColumn, depth, true);
      continue;
    }

    // User/system variables
    if (ch === '@') {
      advance();
      if (sql[i] === '@') advance();
      while (i < sql.length && (WORD_PART.test(sql[i]) || sql[i] === '.')) advance();
      push('variable', sql.slice(start, i), start, i, startLine, startColumn, depth);
      continue;
    }

    // Numbers, including 0x / 0b
    if (DIGIT.test(ch) || (ch === '.' && next && DIGIT.test(next))) {
      if (ch === '0' && (next === 'x' || next === 'X' || next === 'b' || next === 'B')) {
        advance(2);
        while (i < sql.length && /[0-9a-fA-F]/.test(sql[i])) advance();
      } else {
        while (i < sql.length && DIGIT.test(sql[i])) advance();
        if (sql[i] === '.') {
          advance();
          while (i < sql.length && DIGIT.test(sql[i])) advance();
        }
        if (sql[i] === 'e' || sql[i] === 'E') {
          const save = i;
          advance();
          if (sql[i] === '+' || sql[i] === '-') advance();
          if (DIGIT.test(sql[i] ?? '')) {
            while (i < sql.length && DIGIT.test(sql[i])) advance();
          } else {
            i = save;
            column -= 1;
          }
        }
      }
      push('number', sql.slice(start, i), start, i, startLine, startColumn, depth);
      continue;
    }

    // Words
    if (WORD_START.test(ch)) {
      advance();
      while (i < sql.length && WORD_PART.test(sql[i])) advance();
      push('word', sql.slice(start, i), start, i, startLine, startColumn, depth);
      continue;
    }

    // Punctuation and operators
    const two = sql.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', ':=', '||', '&&', '<<', '>>'].includes(two)) {
      advance(2);
      push('punct', two, start, i, startLine, startColumn, depth);
      continue;
    }

    if (ch === '(') {
      advance();
      push('punct', ch, start, i, startLine, startColumn, depth);
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      advance();
      push('punct', ch, start, i, startLine, startColumn, depth);
      continue;
    }

    advance();
    push('punct', ch, start, i, startLine, startColumn, depth);
  }

  return tokens;
}

export function significantTokens(tokens: Token[]): Token[] {
  return tokens.filter((token) => token.kind !== 'comment');
}

export function tokenUpper(token: Token | undefined): string {
  return token ? token.value.toUpperCase() : '';
}

export function findTopLevelSequence(tokens: Token[], ...words: string[]): number {
  const upper = words.map((word) => word.toUpperCase());
  for (let i = 0; i <= tokens.length - upper.length; i += 1) {
    if (tokens[i].depth !== 0) continue;
    let matched = true;
    for (let j = 0; j < upper.length; j += 1) {
      if (tokens[i + j].depth !== 0 || tokenUpper(tokens[i + j]) !== upper[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

export function containsWord(tokens: Token[], word: string): boolean {
  const upper = word.toUpperCase();
  return tokens.some((token) => token.kind === 'word' && tokenUpper(token) === upper);
}

export interface SplitStatement {
  sql: string;
  start: number;
  end: number;
  line: number;
  tokens: Token[];
}

/**
 * A `DELIMITER` directive.
 *
 * `DELIMITER` is a command of the mysql **client**, not of the server: the
 * client uses it to decide where one statement ends, so the text after it
 * never reaches the server. The rule mirrors the client - the word must be
 * the first thing on its line, and the rest of the line is the terminator.
 */
export interface DelimiterDirective {
  /** The statement terminator that applies from here on. */
  terminator: string;
  /** Offset of the directive word in the source. */
  start: number;
  /** Offset just past the terminator. */
  end: number;
}

/**
 * Find the `DELIMITER` directives of a script.
 *
 * Only a word that stands alone at the start of its line counts, and the
 * terminator must be a single non-empty run of non-whitespace characters.
 * Anything else is ordinary SQL and is left alone.
 */
function findDelimiterDirectives(sql: string, tokens: Token[]): DelimiterDirective[] {
  const directives: DelimiterDirective[] = [];
  for (const token of tokens) {
    if (token.kind !== 'word' || token.quoted) continue;
    if (token.value.toUpperCase() !== 'DELIMITER') continue;
    // Only whitespace may precede the word on its line.
    const lineStart = sql.lastIndexOf('\n', token.start - 1) + 1;
    if (sql.slice(lineStart, token.start).trim() !== '') continue;
    const lineEnd = sql.indexOf('\n', token.end);
    const lineEndOffset = lineEnd === -1 ? sql.length : lineEnd;
    const rest = sql.slice(token.end, lineEndOffset);
    // A trailing comment is not part of the terminator.
    let contentEnd = rest.length;
    for (const other of tokens) {
      if (other.kind === 'comment' && other.start >= token.end && other.start < lineEndOffset) {
        contentEnd = other.start - token.end;
        break;
      }
    }
    const raw = rest.slice(0, contentEnd);
    const terminator = raw.trim();
    if (terminator === '' || /\s/.test(terminator)) continue;
    directives.push({
      terminator,
      start: token.start,
      end: token.end + raw.indexOf(terminator) + terminator.length,
    });
  }
  return directives;
}

/**
 * The character ranges a custom terminator must not match inside: string
 * literals, comments and backtick-quoted identifiers.
 */
function terminatorUnsafeRanges(tokens: Token[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    if (
      token.kind === 'string' ||
      token.kind === 'comment' ||
      (token.kind === 'word' && token.quoted)
    ) {
      ranges.push([token.start, token.end]);
    }
  }
  return ranges;
}

/** The offsets at which a custom terminator appears in code. */
function findTerminatorOffsets(
  sql: string,
  from: number,
  to: number,
  terminator: string,
  unsafe: Array<[number, number]>,
): number[] {
  const offsets: number[] = [];
  let index = sql.indexOf(terminator, from);
  while (index !== -1 && index < to) {
    const end = index + terminator.length;
    const inside = unsafe.some(([start, stop]) => start < end && index < stop);
    if (!inside) offsets.push(index);
    index = sql.indexOf(terminator, end);
  }
  return offsets;
}

/**
 * Whether the script contains a `DELIMITER` directive.
 *
 * A routine whose body is wrapped in one is a single statement; the same
 * routine without a directive is cut apart at the semicolons in its body.
 */
export function hasDelimiterDirective(sql: string, tokens?: Token[]): boolean {
  return findDelimiterDirectives(sql, tokens ?? tokenize(sql)).length > 0;
}

/**
 * Split one region of a script on the given terminator.
 */
function splitRegion(
  sql: string,
  allTokens: Token[],
  from: number,
  to: number,
  terminator: string,
  unsafe: Array<[number, number]> = [],
): SplitStatement[] {
  const statements: SplitStatement[] = [];
  const cuts: Array<{ contentEnd: number; nextStart: number }> = [];
  if (terminator === ';') {
    for (const token of allTokens) {
      if (token.start < from || token.end > to) continue;
      if (token.kind === 'punct' && token.value === ';' && token.depth === 0) {
        cuts.push({ contentEnd: token.start, nextStart: token.end });
      }
    }
  } else {
    for (const offset of findTerminatorOffsets(sql, from, to, terminator, unsafe)) {
      cuts.push({ contentEnd: offset, nextStart: offset + terminator.length });
    }
  }
  cuts.push({ contentEnd: to, nextStart: to });

  let segmentStart = from;
  for (const cut of cuts) {
    const segmentTokens = allTokens.filter(
      (token) => token.start >= segmentStart && token.end <= cut.contentEnd,
    );
    // A segment that holds nothing but comments is not a statement.
    const codeTokens = segmentTokens.filter((token) => token.kind !== 'comment');
    if (codeTokens.length > 0) {
      statements.push({
        sql: sql.slice(segmentStart, cut.contentEnd).trim(),
        start: segmentStart,
        end: cut.contentEnd,
        line: codeTokens[0].line,
        tokens: segmentTokens,
      });
    }
    segmentStart = cut.nextStart;
  }
  return statements;
}

/**
 * Split a script into statements.
 *
 * The script is split on the current statement terminator, which is `;` unless
 * a `DELIMITER` directive changes it. Semicolons inside strings, comments and
 * parentheses are ignored. A `DELIMITER` directive is a client-side
 * instruction: it is consumed here and never becomes a statement, so it is
 * never sent to the server.
 *
 * When the caller already tokenized the script it can pass the token list in,
 * so the script is not tokenized twice.
 */
export function splitStatements(sql: string, tokens?: Token[]): SplitStatement[] {
  const allTokens = tokens ?? tokenize(sql);
  const directives = findDelimiterDirectives(sql, allTokens);
  if (directives.length === 0) {
    return splitRegion(sql, allTokens, 0, sql.length, ';');
  }
  const unsafe = terminatorUnsafeRanges(allTokens);
  const statements: SplitStatement[] = [];
  let regionStart = 0;
  let terminator = ';';
  for (const directive of directives) {
    statements.push(
      ...splitRegion(sql, allTokens, regionStart, directive.start, terminator, unsafe),
    );
    terminator = directive.terminator;
    regionStart = directive.end;
  }
  statements.push(...splitRegion(sql, allTokens, regionStart, sql.length, terminator, unsafe));
  return statements;
}

/** Remove comments while preserving newlines, for lightweight display/analysis. */
export function stripComments(sql: string): string {
  const tokens = tokenize(sql);
  let out = '';
  let cursor = 0;
  for (const token of tokens) {
    if (token.kind !== 'comment') continue;
    out += sql.slice(cursor, token.start);
    out += token.raw.replace(/[^\n]/g, ' ');
    cursor = token.end;
  }
  out += sql.slice(cursor);
  return out;
}
