import { describe, expect, it } from 'vitest';
import {
  PRACTICE_TOPICS,
  type PracticeAttempt,
  type PracticeQuestion,
  type PracticeSet,
  type QueryColumn,
  type QueryResult,
} from '../shared/types';
import {
  buildPracticeAnswers,
  canRevealPracticeAnswers,
  comparePracticeResults,
  isSamePracticeSubmission,
  maskPracticeComparison,
  normalizePracticeSql,
  practiceVerdict,
  scorePractice,
  staticPracticeCorrectness,
  toPublicPracticeAttempt,
  toPublicPracticeProgress,
  toPublicPracticeQuestion,
  toPublicPracticeSet,
} from '../server/db/practice';
import {
  buildPracticeEvaluationMessages,
  buildPracticeGenerationMessages,
} from '../server/ai/practice-prompts';

function columns(count: number): QueryColumn[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `c${index}`,
    originalName: `c${index}`,
    table: 't',
    database: 'shop',
    typeName: 'INT',
    typeCode: 3,
    flags: 0,
  }));
}

function result(rows: unknown[][], columnCount = 2, truncated = false): QueryResult {
  return {
    sql: 'SELECT 1',
    database: 'shop',
    kind: 'read',
    columns: columns(columnCount),
    rows: rows as never,
    rowCount: rows.length,
    truncated,
    affectedRows: 0,
    insertId: null,
    info: '',
    warnings: [],
    executionMs: 1,
    bytesApprox: 1,
    unlocked: false,
    masked: false,
  };
}

describe('practice result comparison', () => {
  it('matches unordered rows', () => {
    const comparison = comparePracticeResults(
      result([
        [1, 'a'],
        [2, 'b'],
      ]),
      result([
        [2, 'b'],
        [1, 'a'],
      ]),
      false,
    );
    expect(comparison.matched).toBe(true);
    expect(comparison.matchedRows).toBe(2);
  });

  it('enforces ordering when requested', () => {
    const comparison = comparePracticeResults(
      result([
        [1, 'a'],
        [2, 'b'],
      ]),
      result([
        [2, 'b'],
        [1, 'a'],
      ]),
      true,
    );
    expect(comparison.matched).toBe(false);
    expect(comparison.reason).toContain('order');
  });

  it('reports extra and missing rows', () => {
    const comparison = comparePracticeResults(
      result([
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ]),
      result([
        [1, 'a'],
        [2, 'b'],
      ]),
      false,
    );
    expect(comparison.matched).toBe(false);
    expect(comparison.extraRows).toHaveLength(1);
    expect(comparison.missingRows).toHaveLength(0);
  });

  it('detects column-count differences', () => {
    const comparison = comparePracticeResults(result([[1, 'a']], 2), result([[1]], 1), false);
    expect(comparison.matched).toBe(false);
    expect(comparison.reason).toContain('column');
  });

  it('marks truncated matches', () => {
    const comparison = comparePracticeResults(
      result([[1, 'a']], 2, true),
      result([[1, 'a']], 2),
      false,
    );
    expect(comparison.matched).toBe(true);
    expect(comparison.truncated).toBe(true);
    const scores = scorePractice({
      findings: [],
      comparison,
      executed: true,
    });
    expect(scores.correctness).toBe(90);
    expect(scores.overall).toBe(94);
  });
});

describe('numeric-tolerant result comparison', () => {
  function matches(userRows: unknown[][], referenceRows: unknown[][]): boolean {
    return comparePracticeResults(result(userRows), result(referenceRows), false).matched;
  }

  it('compares decimal aggregates by value, not formatting', () => {
    expect(matches([['12.30']], [['12.3']])).toBe(true);
    expect(matches([['+12.300']], [['12.3']])).toBe(true);
    expect(matches([['1.500']], [['1.5']])).toBe(true);
    expect(matches([['.5']], [['0.5']])).toBe(true);
    expect(matches([[12.3]], [['12.30']])).toBe(true);
    expect(matches([['12.30']], [['12.31']])).toBe(false);
    expect(matches([['-12.30']], [['-12.3']])).toBe(true);
  });

  it('normalizes leading zeros, signed zero, and integer-suffix zeros', () => {
    expect(matches([['007']], [['7']])).toBe(true);
    expect(matches([['-0']], [['0']])).toBe(true);
    expect(matches([['0.000']], [['0']])).toBe(true);
    expect(matches([['100.0']], [['100']])).toBe(true);
    expect(matches([['007A']], [['7A']])).toBe(false);
  });

  it('folds exponent forms into plain decimals', () => {
    expect(matches([['1e3']], [['1000']])).toBe(true);
    expect(matches([['1e3']], [['1000.00']])).toBe(true);
    expect(matches([['1.5e2']], [['150']])).toBe(true);
    expect(matches([['1E-3']], [['0.001']])).toBe(true);
    expect(matches([['2e1']], [['20.5']])).toBe(false);
  });

  it('compares large decimals as strings, never through a float', () => {
    // 9007199254740993 and 9007199254740992 collapse to the same double.
    expect(matches([['9007199254740993']], [['9007199254740992']])).toBe(false);
    expect(matches([['9007199254740992.00']], [['9007199254740992']])).toBe(true);
    expect(
      matches([['0.1234567890123456789012345678901']], [['0.12345678901234567890123456789010']]),
    ).toBe(true);
    expect(
      matches([['0.1234567890123456789012345678901']], [['0.1234567890123456789012345678902']]),
    ).toBe(false);
  });

  it('keeps the exact comparison for non-numeric text', () => {
    expect(matches([['abc']], [['abc']])).toBe(true);
    expect(matches([['abc']], [['abd']])).toBe(false);
    expect(matches([['N/A']], [['N/A ']])).toBe(true); // trimmed, as before
    expect(matches([['12.3abc']], [['12.3']])).toBe(false);
    expect(matches([['']], [['0']])).toBe(false);
  });
});

describe('mask-safe comparison', () => {
  function column(name: string, sensitive: boolean): QueryColumn {
    return {
      name,
      originalName: name,
      table: 'users',
      database: 'shop',
      typeName: 'VARCHAR',
      typeCode: 253,
      flags: 0,
      sensitive,
    };
  }

  function gradedResult(columns: QueryColumn[], rows: unknown[][]): QueryResult {
    return {
      ...result(rows, columns.length),
      columns,
    };
  }

  it('matches raw values regardless of aliased credential column names', () => {
    // `SELECT password AS p` versus `SELECT password`: with raw rows the
    // verdict cannot depend on which side carries the alias.
    const user = gradedResult([column('p', true)], [['s3cret']]);
    const reference = gradedResult([column('password', true)], [['s3cret']]);
    const comparison = comparePracticeResults(user, reference, false);
    expect(comparison.matched).toBe(true);
  });

  it("masks the comparison samples with each side's sensitivity", () => {
    const user = gradedResult([column('p', true), column('name', false)], [['s3cret', 'Alice']]);
    const reference = gradedResult(
      [column('password', true), column('name', false)],
      [['s3cret', 'Bob']],
    );
    const graded = comparePracticeResults(user, reference, false);
    expect(graded.matched).toBe(false);
    const masked = maskPracticeComparison(graded, user, reference, true);
    expect(masked.extraRows).toEqual([['••••••••', 'Alice']]);
    expect(masked.missingRows).toEqual([['••••••••', 'Bob']]);
    // The verdict is untouched by the sample masking.
    expect(masked.matched).toBe(graded.matched);
    expect(masked.matchedRows).toBe(graded.matchedRows);
  });

  it('keeps the verdict honest when the masked-column counts differ', () => {
    // The user aliased the credential column (sensitive) while the reference
    // projection is not: the asymmetry must not flip the verdict either way.
    const user = gradedResult([column('p', true)], [['s3cret'], ['junk']]);
    const reference = gradedResult([column('label', false)], [['other']]);
    const graded = comparePracticeResults(user, reference, false);
    expect(graded.matched).toBe(false);
    const masked = maskPracticeComparison(graded, user, reference, true);
    // Masking is positional: both extra cells sit in the user's sensitive
    // column, while the reference sample stays unmasked (its column is not
    // sensitive, so its values ship unmasked in the result preview too).
    expect(masked.extraRows).toEqual([['••••••••'], ['••••••••']]);
    expect(masked.missingRows).toEqual([['other']]);
  });

  it('leaves the samples untouched when masking is disabled', () => {
    const user = gradedResult([column('p', true)], [['s3cret']]);
    const reference = gradedResult([column('password', true)], [['other']]);
    const graded = comparePracticeResults(user, reference, false);
    const masked = maskPracticeComparison(graded, user, reference, false);
    expect(masked.extraRows).toEqual([['s3cret']]);
    expect(masked.missingRows).toEqual([['other']]);
  });
});

describe('reference-truncation fairness', () => {
  it('does not cap correctness when the reference hit the row cap', () => {
    const rows = [
      [1, 'a'],
      [2, 'b'],
    ];
    const comparison = comparePracticeResults(result(rows), result(rows, 2, true), false);
    expect(comparison.matched).toBe(true);
    expect(comparison.truncated).toBe(true);
    expect(comparison.referenceTruncated).toBe(true);
    const scores = scorePractice({ findings: [], comparison, executed: true });
    expect(scores.correctness).toBe(100);
    expect(scores.overall).toBe(100);
    expect(practiceVerdict(comparison, true, scores)).toBe('correct');
  });

  it('treats two cap-sized results as a full match', () => {
    const rows = [
      [1, 'a'],
      [2, 'b'],
    ];
    const comparison = comparePracticeResults(result(rows, 2, true), result(rows, 2, true), false);
    expect(comparison.referenceTruncated).toBe(true);
    expect(scorePractice({ findings: [], comparison, executed: true }).correctness).toBe(100);
  });

  it('still penalizes truncation caused by the user result', () => {
    const comparison = comparePracticeResults(
      result([[1, 'a']], 2, true),
      result([[1, 'a']], 2),
      false,
    );
    expect(comparison.referenceTruncated).toBe(false);
    expect(scorePractice({ findings: [], comparison, executed: true }).correctness).toBe(90);
  });
});

describe('practice scoring', () => {
  it('gives full credit for a matching result', () => {
    const comparison = comparePracticeResults(result([[1, 'a']]), result([[1, 'a']]), false);
    const scores = scorePractice({ findings: [], comparison, executed: true });
    expect(scores.correctness).toBe(100);
    expect(scores.performance).toBe(100);
    expect(scores.style).toBe(100);
    expect(scores.overall).toBe(100);
    expect(practiceVerdict(comparison, true, scores)).toBe('correct');
  });

  it('uses AI scores for non-executed answers', () => {
    const scores = scorePractice({
      findings: [],
      comparison: null,
      executed: false,
      aiScores: { correctness: 80, performance: 90, style: 90 },
    });
    expect(scores.overall).toBe(84);
  });
});

function question(overrides: Partial<PracticeQuestion> = {}): PracticeQuestion {
  return {
    id: 'q1',
    type: 'write-query',
    title: 'Customers with large orders',
    scenario: 'List the customers who placed an order above 100.',
    difficulty: 'medium',
    topics: ['joins'],
    schemaTables: ['customers', 'orders'],
    brokenSql: null,
    referenceSql:
      'SELECT c.id, c.name FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.total > 100 ORDER BY c.name',
    expectedResult: 'id | name',
    orderMatters: true,
    hints: ['Think about the join key.'],
    estimatedMinutes: 10,
    execute: true,
    ...overrides,
  };
}

function practiceSet(questions: PracticeQuestion[] = [question()]): PracticeSet {
  return {
    id: 'set-1',
    userId: 'practice-test-user',
    profileId: 'profile-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    database: 'shop',
    providerId: 'provider-1',
    model: 'test-model',
    summary: 'One set',
    questions,
  };
}

function attempt(overrides: Partial<PracticeAttempt> = {}): PracticeAttempt {
  return {
    id: 'attempt-1',
    userId: 'practice-test-user',
    profileId: 'profile-a',
    setId: 'set-1',
    questionId: 'q1',
    database: 'shop',
    topics: ['joins'],
    difficulty: 'medium',
    userSql: 'SELECT 1',
    userAnswer: '',
    evaluation: {
      questionId: 'q1',
      executed: true,
      verdict: 'correct',
      scores: { correctness: 100, performance: 100, style: 100, overall: 100 },
      summary: 'ok',
      strengths: [],
      issues: [],
      nextHint: '',
      comparison: null,
      findings: [],
      explain: null,
      aiFeedback: null,
      referenceSql: 'SELECT c.id FROM customers c',
      userSql: 'SELECT 1',
      userAnswer: null,
      userResult: null,
      referenceResult: null,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('practice answer leakage', () => {
  it('drops the reference solution, expected output, and broken input for non-fix tasks', () => {
    const pub = toPublicPracticeQuestion(question({ brokenSql: 'SELECT broken' }));
    expect(pub).not.toHaveProperty('referenceSql');
    expect(pub).not.toHaveProperty('expectedResult');
    expect(pub).not.toHaveProperty('brokenSql');
    expect(pub.id).toBe('q1');
    expect(pub.schemaTables).toEqual(['customers', 'orders']);
    expect(pub.execute).toBe(true);
  });

  it('keeps the broken statement visible for fix-query tasks', () => {
    const pub = toPublicPracticeQuestion(
      question({
        type: 'fix-query',
        brokenSql: 'SELECT c.id FROM customers c WHERE c.total >',
      }),
    );
    expect(pub.type).toBe('fix-query');
    expect(pub.brokenSql).toBe('SELECT c.id FROM customers c WHERE c.total >');
    expect(pub).not.toHaveProperty('referenceSql');
    expect(pub).not.toHaveProperty('expectedResult');
  });

  it('keeps broken input hidden for the other task types', () => {
    for (const type of ['write-query', 'review-query', 'concept'] as const) {
      const pub = toPublicPracticeQuestion(question({ type, brokenSql: 'SELECT broken' }));
      expect(pub).not.toHaveProperty('brokenSql');
    }
  });

  it('strips hints that contain a statement but keeps guidance', () => {
    const pub = toPublicPracticeQuestion(
      question({
        hints: [
          'Join customers to orders on the customer id.',
          'SELECT c.id, c.name FROM customers c',
        ],
      }),
    );
    expect(pub.hints).toEqual(['Join customers to orders on the customer id.']);
  });

  it('keeps prose hints that talk about selecting and from', () => {
    const pub = toPublicPracticeQuestion(
      question({
        hints: [
          'Think about selecting the customers from Germany.',
          'Select the columns from two tables.',
          'Use a SELECT with a WHERE clause; the FROM part is easy.',
          'select one from the list of aggregations.',
          '```Join on the customer id```',
        ],
      }),
    );
    expect(pub.hints).toHaveLength(5);
  });

  it('still drops hints that are statements in disguise', () => {
    const pub = toPublicPracticeQuestion(
      question({
        hints: [
          'SELECT c.id FROM customers c WHERE c.country = DE',
          'select * from users;',
          '```sql\nSELECT password FROM users\n```',
          'INSERT INTO users VALUES (1)',
          'UPDATE users SET password = x',
          'DELETE FROM users WHERE id = 1',
        ],
      }),
    );
    expect(pub.hints).toHaveLength(0);
  });

  it('drops a hint whose FROM source names a schema table', () => {
    const pub = toPublicPracticeQuestion(question({ hints: ['select whatever from customers'] }));
    expect(pub.hints).toHaveLength(0);
  });

  it('sanitizes sets, attempts, and progress payloads', () => {
    const set = practiceSet();
    const pubSet = toPublicPracticeSet(set);
    const serialized = JSON.stringify(pubSet);
    expect(serialized).not.toContain('c.id, c.name');
    expect(serialized).not.toContain('id | name');
    expect(pubSet.questions[0]).not.toHaveProperty('referenceSql');

    const pubAttempt = toPublicPracticeAttempt(attempt());
    expect(pubAttempt.evaluation).not.toHaveProperty('referenceSql');
    expect(pubAttempt.evaluation).not.toHaveProperty('referenceResult');
    expect(pubAttempt.evaluation.scores.overall).toBe(100);

    const progress = toPublicPracticeProgress({
      totalAttempts: 1,
      averageScore: 100,
      topics: [],
      recent: [attempt()],
      recommendedTopics: [],
    });
    expect(progress.recent[0]).not.toHaveProperty('evaluation.referenceSql');
    expect(
      (progress.recent[0].evaluation as { referenceSql?: unknown }).referenceSql,
    ).toBeUndefined();
  });

  it('only releases answers to the owning profile', () => {
    expect(canRevealPracticeAnswers({ profileId: 'profile-a' }, 'profile-a')).toBe(true);
    expect(canRevealPracticeAnswers({ profileId: 'profile-a' }, 'profile-b')).toBe(false);
  });

  it('releases answers only for attempted questions', () => {
    const set = practiceSet([
      question({ id: 'q1' }),
      question({ id: 'q2', referenceSql: 'SELECT COUNT(*) FROM orders' }),
    ]);
    const answers = buildPracticeAnswers(set, new Set(['q1']));
    expect(answers.setId).toBe('set-1');
    expect(answers.answers).toHaveLength(1);
    expect(answers.answers[0].questionId).toBe('q1');
    expect(answers.answers[0].referenceSql).toBe(set.questions[0].referenceSql);
    expect(buildPracticeAnswers(set, new Set()).answers).toHaveLength(0);
  });
});

describe('practice scoring without AI', () => {
  it('scores a strong non-executed answer above the old 40 cap', () => {
    const item = question();
    const scores = scorePractice({
      findings: [],
      comparison: null,
      executed: false,
      submission: {
        userSql: item.referenceSql ?? '',
        userAnswer: '',
        questionType: item.type,
        referenceSql: item.referenceSql,
      },
    });
    expect(scores.correctness).toBe(100);
    expect(scores.overall).toBeGreaterThan(40);
    expect(scores.overall).toBe(100);
  });

  it('scores partial structure between empty and complete answers', () => {
    const item = question();
    const partial = scorePractice({
      findings: [],
      comparison: null,
      executed: false,
      submission: {
        userSql: 'SELECT * FROM customers',
        userAnswer: '',
        questionType: item.type,
        referenceSql: item.referenceSql,
      },
    });
    expect(partial.correctness).toBeGreaterThan(0);
    expect(partial.correctness).toBeLessThan(100);
    expect(partial.overall).toBeGreaterThan(40);
  });

  it('keeps an empty submission low', () => {
    const scores = scorePractice({
      findings: [],
      comparison: null,
      executed: false,
      submission: {
        userSql: '',
        userAnswer: '',
        questionType: 'write-query',
        referenceSql: 'SELECT 1',
      },
    });
    expect(scores.correctness).toBe(0);
    expect(scores.overall).toBe(40);
  });

  it('penalizes correctness findings on the structural score', () => {
    const item = question();
    const scores = scorePractice({
      findings: [
        {
          id: 'f1',
          ruleId: 'test.correctness',
          title: 'Wrong predicate',
          severity: 'critical',
          category: 'correctness',
          message: 'The predicate is wrong.',
          recommendation: 'Fix it.',
          source: 'rule',
        },
      ],
      comparison: null,
      executed: false,
      submission: {
        userSql: item.referenceSql ?? '',
        userAnswer: '',
        questionType: item.type,
        referenceSql: item.referenceSql,
      },
    });
    expect(scores.correctness).toBe(70);
    expect(scores.overall).toBeLessThan(100);
  });

  it('ignores structure when an AI score is present', () => {
    const scores = scorePractice({
      findings: [],
      comparison: null,
      executed: false,
      aiScores: { correctness: 10, performance: 10, style: 10 },
      submission: {
        userSql: 'SELECT c.id FROM customers c',
        userAnswer: '',
        questionType: 'write-query',
        referenceSql: 'SELECT c.id FROM customers c',
      },
    });
    expect(scores.correctness).toBe(10);
    expect(scores.overall).toBe(10);
  });

  it('gives concept answers credit for prose', () => {
    const scores = staticPracticeCorrectness({
      userSql: '',
      userAnswer:
        'A covering index avoids the clustered index lookup because every selected column lives in the secondary index.',
      questionType: 'concept',
      referenceSql: null,
    });
    expect(scores).toBeGreaterThan(40);
  });
});

describe('duplicate attempt detection', () => {
  it('normalizes case, comments, whitespace, and trailing semicolons', () => {
    expect(normalizePracticeSql('  SELECT  *  FROM t ; ')).toBe('select * from t');
    expect(normalizePracticeSql('SELECT 1 -- note\n')).toBe('select 1');
  });

  it('treats a reformatted resubmission as the same answer', () => {
    expect(
      isSamePracticeSubmission(
        { userSql: 'SELECT  * FROM t;', userAnswer: '  Because  indexes ' },
        { userSql: 'select * from t', userAnswer: 'because indexes' },
      ),
    ).toBe(true);
  });

  it('distinguishes different SQL or explanations', () => {
    expect(
      isSamePracticeSubmission(
        { userSql: 'SELECT * FROM t', userAnswer: '' },
        { userSql: 'SELECT * FROM u', userAnswer: '' },
      ),
    ).toBe(false);
    expect(
      isSamePracticeSubmission(
        { userSql: 'SELECT * FROM t', userAnswer: 'a' },
        { userSql: 'SELECT * FROM t', userAnswer: 'b' },
      ),
    ).toBe(false);
  });
});

describe('evaluation prompt anti-cheat', () => {
  const referenceSql = question().referenceSql ?? '';

  function promptMessages(executed: boolean): string {
    const user = result([[1, 'a']]);
    const reference = result([[1, 'a']]);
    return buildPracticeEvaluationMessages({
      server: null,
      database: 'shop',
      question: question(),
      userSql: 'SELECT c.id FROM customers c',
      userAnswer: '',
      executed,
      comparison: comparePracticeResults(user, reference, false),
      findings: [],
      explain: null,
      userResult: executed ? user : null,
      referenceResult: executed ? reference : null,
      schemaText: 'SCHEMA DUMMY',
    })
      .map((message) => message.content)
      .join('\n');
  }

  it('withholds the reference solution and result when the answer was executed', () => {
    const prompt = promptMessages(true);
    expect(prompt).not.toContain('REFERENCE SQL');
    expect(prompt).not.toContain('REFERENCE RESULT SAMPLE');
    expect(prompt).not.toContain(referenceSql);
    // The learner-side material the model coaches from is still present.
    expect(prompt).toContain('EXECUTED: true');
    expect(prompt).toContain('DETERMINISTIC COMPARISON');
    expect(prompt).toContain('LEARNER RESULT SAMPLE');
    expect(prompt).toContain('SCHEMA DUMMY');
  });

  it('keeps the reference material for non-executed grading', () => {
    const prompt = promptMessages(false);
    expect(prompt).toContain('REFERENCE SQL');
    expect(prompt).toContain(referenceSql);
    expect(prompt).toContain('EXPECTED RESULT / RUBRIC');
    expect(prompt).toContain('EXECUTED: false');
  });
});

describe('programmable objects practice topics (views, procedures, triggers)', () => {
  it('includes views, procedures, and triggers in the 16 standard practice topics', () => {
    const ids = PRACTICE_TOPICS.map((topic) => topic.id);
    expect(ids).toContain('views');
    expect(ids).toContain('procedures');
    expect(ids).toContain('triggers');
    expect(PRACTICE_TOPICS).toHaveLength(16);

    const labels = Object.fromEntries(PRACTICE_TOPICS.map((t) => [t.id, t.label]));
    expect(labels.views).toBe('Views');
    expect(labels.procedures).toBe('Stored procedures & functions');
    expect(labels.triggers).toBe('Triggers');
  });

  it('generates prompt messages including programmable topics and guidelines', () => {
    const messages = buildPracticeGenerationMessages({
      server: null,
      database: 'shop',
      tables: ['orders', 'customers'],
      topics: ['views', 'procedures', 'triggers'],
      difficulty: 'medium',
      count: 3,
      schemaText: 'TABLE shop.orders\nTABLE shop.customers',
      sampleDataText: '',
    });
    const content = messages.map((m) => m.content).join('\n');
    expect(content).toContain('TOPICS: views, procedures, triggers');
    expect(content).toContain('"views"');
    expect(content).toContain('"procedures"');
    expect(content).toContain('"triggers"');
    expect(content).toContain('stored procedures and functions');
  });
});
