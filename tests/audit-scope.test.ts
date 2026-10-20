import { describe, expect, it } from 'vitest';
import type { ServerInfo } from '../shared/types';
import { runAudit } from '../server/review/audit';
import { createProfile } from '../server/store/profiles';

describe('audit server-wide scope guard', () => {
  it('rejects a scoped connection with server-wide insights disabled', async () => {
    const profile = await createProfile({
      name: 'Scoped connection',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      databaseScope: 'selected',
      allowedDatabases: ['shop'],
      allowServerWideInsights: false,
    });

    // The guard must fire before any database collection, so an empty server
    // object is never read.
    await expect(
      runAudit({
        profileId: profile.id,
        databases: ['shop'],
        server: {} as ServerInfo,
      }),
    ).rejects.toMatchObject({
      code: 'SERVER_WIDE_INSIGHTS_DISABLED',
      status: 403,
    });
  });
});
