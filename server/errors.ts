export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly sqlState?: string;
  readonly errno?: number;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: unknown,
    extra?: { sqlState?: string; errno?: number },
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.sqlState = extra?.sqlState;
    this.errno = extra?.errno;
  }
}

interface MysqlLikeError {
  code?: string;
  errno?: number;
  sqlState?: string;
  sqlMessage?: string;
  message?: string;
  fatal?: boolean;
}

/**
 * Copy for the `ER_*` codes a user can act on.
 *
 * The raw MySQL text is deliberately not returned: it names internal
 * databases and tables and can repeat a stored column value
 * (`ER_DUP_ENTRY`). These messages say what went wrong and what to do next
 * without echoing any of that, so a failed statement still tells the user
 * how to fix it.
 */
const SAFE_ERROR_COPY: Record<string, { code: string; message: string; status?: number }> = {
  ER_BAD_FIELD_ERROR: {
    code: 'UNKNOWN_COLUMN',
    message: 'Unknown column. Check the column names against the schema panel on the left.',
  },
  ER_BAD_NULL_ERROR: {
    code: 'MISSING_VALUE',
    message: 'A column that does not allow NULL was left empty. Give it a value, or allow NULL.',
  },
  ER_DUP_ENTRY: {
    code: 'DUPLICATE_ROW',
    message: 'That row already exists. Edit the existing row instead of inserting a second one.',
  },
  ER_DATA_TOO_LONG: {
    code: 'VALUE_TOO_LONG',
    message: 'A value is longer than its column allows. Shorten it, or use a longer column.',
  },
  ER_TRUNCATED_WRONG_VALUE: {
    code: 'VALUE_TYPE_MISMATCH',
    message: 'A value does not match the type of its column.',
  },
  ER_DIVISION_BY_ZERO: {
    code: 'DIVISION_BY_ZERO',
    message: 'The statement divides by zero. Guard the divisor with NULLIF or a CASE.',
  },
  ER_NO_REFERENCED_ROW: {
    code: 'FOREIGN_KEY_MISSING',
    message: 'A foreign key points at a row that does not exist.',
  },
  ER_NO_REFERENCED_ROW_2: {
    code: 'FOREIGN_KEY_MISSING',
    message: 'A foreign key points at a row that does not exist.',
  },
  ER_ROW_IS_REFERENCED: {
    code: 'ROW_IN_USE',
    message: 'That row is referenced by another table and cannot be removed.',
  },
  ER_ROW_IS_REFERENCED_2: {
    code: 'ROW_IN_USE',
    message: 'That row is referenced by another table and cannot be removed.',
  },
  ER_LOCK_DEADLOCK: {
    code: 'DEADLOCK',
    message: 'The statement deadlocked with another one. Run it again.',
  },
  ER_LOCK_WAIT_TIMEOUT: {
    code: 'LOCK_TIMEOUT',
    message: 'The statement waited too long for a lock held by another session.',
  },
  ER_TOO_MANY_USER_CONNECTIONS: {
    code: 'TOO_MANY_CONNECTIONS',
    message: 'The server has no free connections left. Try again in a moment.',
    status: 503,
  },
  ER_CON_COUNT_ERROR: {
    code: 'TOO_MANY_CONNECTIONS',
    message: 'The server has no free connections left. Try again in a moment.',
    status: 503,
  },
  ER_OUT_OF_RANGE: {
    code: 'VALUE_OUT_OF_RANGE',
    message: 'A value is outside the range its column allows.',
  },
  ER_WARN_DATA_OUT_OF_RANGE: {
    code: 'VALUE_OUT_OF_RANGE',
    message: 'A value was outside the range its column allows, and the server adjusted it.',
  },
  ER_SP_DOES_NOT_EXIST: {
    code: 'ROUTINE_NOT_FOUND',
    message: 'That stored routine does not exist on this server.',
  },
  ER_SP_WRONG_NO_OF_ARGS: {
    code: 'ROUTINE_ARGUMENTS',
    message: 'The routine was called with the wrong number of arguments.',
  },
  ER_SIGNAL_EXCEPTION: {
    code: 'STATEMENT_SIGNALLED',
    message: 'The routine raised an error while it was running.',
  },
  ER_QUERY_TIMEOUT: {
    code: 'QUERY_TIMEOUT',
    message: 'The statement ran past the query timeout. Narrow it, or raise the timeout.',
  },
};

export function mapDbError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const err = (error ?? {}) as MysqlLikeError;
  const code = err.code ?? 'DB_ERROR';
  const raw = err.sqlMessage ?? err.message ?? 'Unknown database error';
  const extra = { sqlState: err.sqlState, errno: err.errno };

  switch (code) {
    case 'ECONNREFUSED':
      return new AppError(
        'CONNECTION_REFUSED',
        'MySQL refused the connection. Is the server running? In XAMPP, start MySQL from the control panel.',
        502,
        { code },
      );
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new AppError('HOST_NOT_FOUND', `The host could not be resolved: ${raw}`, 502, {
        code,
      });
    case 'ETIMEDOUT':
    case 'PROTOCOL_SEQUENCE_TIMEOUT':
      return new AppError(
        'CONNECTION_TIMEOUT',
        'The connection timed out. Check the host, port, and firewall.',
        504,
        { code },
      );
    case 'ER_ACCESS_DENIED_ERROR':
      return new AppError(
        'ACCESS_DENIED',
        'Access denied. Check the username and password for this MySQL account.',
        401,
        { code },
        extra,
      );
    case 'ER_BAD_DB_ERROR':
      return new AppError(
        'DATABASE_NOT_FOUND',
        'That database does not exist.',
        404,
        { code },
        extra,
      );
    case 'ER_DBACCESS_DENIED_ERROR':
      return new AppError(
        'DATABASE_ACCESS_DENIED',
        'This MySQL user does not have access to that database.',
        403,
        { code },
        extra,
      );
    case 'ER_NO_SUCH_TABLE':
      return new AppError('TABLE_NOT_FOUND', raw, 404, { code }, extra);
    case 'ER_TABLEACCESS_DENIED_ERROR':
    case 'ER_COLUMNACCESS_DENIED_ERROR':
      return new AppError('TABLE_ACCESS_DENIED', raw, 403, { code }, extra);
    case 'ER_PARSE_ERROR':
      return new AppError('SQL_PARSE_ERROR', raw, 400, { code }, extra);
    case 'ER_QUERY_INTERRUPTED':
      return new AppError(
        'QUERY_TIMEOUT',
        'The statement was interrupted, most likely because it exceeded the query timeout.',
        408,
        { code },
        extra,
      );
    case 'PROTOCOL_CONNECTION_LOST':
      return new AppError('CONNECTION_LOST', 'The MySQL connection was lost. Try again.', 502, {
        code,
      });
    case 'ER_SPECIFIC_ACCESS_DENIED_ERROR':
      return new AppError('PRIVILEGE_DENIED', raw, 403, { code }, extra);
    case 'ER_NOT_SUPPORTED_YET':
      return new AppError('UNSUPPORTED', raw, 400, { code }, extra);
    default:
      if (code.startsWith('ER_')) {
        // The raw MySQL text names internal databases and tables and can
        // repeat a stored column value (ER_DUP_ENTRY). Only a safe summary
        // is handed back to the client, but it still says what to fix.
        const safe = SAFE_ERROR_COPY[code];
        if (safe) {
          return new AppError(safe.code, safe.message, safe.status ?? 400, { code }, extra);
        }
        return new AppError(
          'MYSQL_ERROR',
          'The database rejected the statement.',
          400,
          { code },
          extra,
        );
      }
      return new AppError('DB_ERROR', raw, 500, { code }, extra);
  }
}

export function isFatalConnectionError(error: unknown): boolean {
  const err = (error ?? {}) as MysqlLikeError;
  return (
    err.fatal === true ||
    err.code === 'PROTOCOL_CONNECTION_LOST' ||
    err.code === 'PROTOCOL_SEQUENCE_TIMEOUT' ||
    err.code === 'ECONNRESET'
  );
}
