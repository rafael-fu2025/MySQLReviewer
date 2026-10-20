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

    // Line comments
    if (ch === '#' || (ch === '-' && next === '-')) {
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
  return tokens.some(
    (token) => token.kind === 'word' && tokenUpper(token) === upper,
  );
}

export interface SplitStatement {
  sql: string;
  start: number;
  end: number;
  line: number;
  tokens: Token[];
}

/**
 * Split on top-level semicolons. Semicolons inside strings, comments, and
 * parentheses are ignored. Empty/comment-only segments are dropped.
 */
export function splitStatements(sql: string): SplitStatement[] {
  const tokens = tokenize(sql);
  const statements: SplitStatement[] = [];
  let segmentStart = 0;
  let segmentStartLine = 1;
  let segmentHasCode = false;

  const flush = (endOffset: number): void => {
    if (!segmentHasCode) return;
    const text = sql.slice(segmentStart, endOffset);
    const segmentTokens = tokens.filter(
      (token) => token.start >= segmentStart && token.end <= endOffset,
    );
    statements.push({
      sql: text.trim(),
      start: segmentStart,
      end: endOffset,
      line: segmentStartLine,
      tokens: segmentTokens,
    });
    segmentHasCode = false;
  };

  for (const token of tokens) {
    if (token.kind !== 'comment' && !segmentHasCode) {
      segmentHasCode = true;
      segmentStartLine = token.line;
    }
    if (token.kind === 'comment') continue;
    if (token.kind === 'punct' && token.value === ';' && token.depth === 0) {
      flush(token.start);
      segmentStart = token.end;
      segmentStartLine = token.line;
      segmentHasCode = false;
    }
  }
  flush(sql.length);
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
