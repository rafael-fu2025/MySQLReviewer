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
      return new AppError('HOST_NOT_FOUND', `The host could not be resolved: ${raw}`, 502, { code });
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
      return new AppError('DATABASE_NOT_FOUND', 'That database does not exist.', 404, { code }, extra);
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
      return new AppError('CONNECTION_LOST', 'The MySQL connection was lost. Try again.', 502, { code });
    case 'ER_SPECIFIC_ACCESS_DENIED_ERROR':
      return new AppError('PRIVILEGE_DENIED', raw, 403, { code }, extra);
    case 'ER_NOT_SUPPORTED_YET':
      return new AppError('UNSUPPORTED', raw, 400, { code }, extra);
    default:
      if (code.startsWith('ER_')) {
        return new AppError('MYSQL_ERROR', raw, 400, { code }, extra);
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
