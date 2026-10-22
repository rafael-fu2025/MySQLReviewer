import type { AiProvider, ColumnInfo, SchemaSnapshot, SchemaTable } from '../shared/types';

export function column(name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    position: 1,
    dataType: 'int',
    columnType: 'int(11)',
    nullable: false,
    defaultValue: null,
    extra: '',
    key: '',
    comment: '',
    charset: null,
    collation: null,
    generationExpression: null,
    ...overrides,
  };
}

export function table(name: string, overrides: Partial<SchemaTable> = {}): SchemaTable {
  return {
    database: 'shop',
    name,
    type: 'BASE TABLE',
    engine: 'InnoDB',
    rowsEstimate: 1000,
    dataBytes: 16_384,
    indexBytes: 16_384,
    dataFreeBytes: 0,
    collation: 'utf8mb4_general_ci',
    charset: 'utf8mb4',
    comment: '',
    columns: [column('id', { key: 'PRI', extra: 'auto_increment' })],
    indexes: [
      {
        name: 'PRIMARY',
        unique: true,
        type: 'BTREE',
        columns: [{ name: 'id', subPart: null, collation: 'A' }],
        cardinality: 1000,
        comment: '',
      },
    ],
    foreignKeys: [],
    ...overrides,
  };
}

export function schema(tables: SchemaTable[]): SchemaSnapshot {
  return {
    database: 'shop',
    tables,
    fetchedAt: new Date().toISOString(),
  };
}

export const testProvider: AiProvider = {
  id: 'provider-test',
  name: 'Test provider',
  type: 'openai',
  baseUrl: 'https://api.example.test/v1',
  chatPath: '/chat/completions',
  modelsPath: '/models',
  model: 'test-model',
  models: [],
  hasApiKey: false,
  apiKeyHint: null,
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  headers: {},
  extraBody: {},
  temperature: 0.2,
  maxTokens: 512,
  streaming: true,
  isDefault: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
