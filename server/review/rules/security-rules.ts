import type { Finding } from '../../../shared/types';
import type { SecurityData, UserPrivilegeSummary } from '../../db/security-audit';
import { createFinding } from '../findings';

const SOCKET_PLUGINS = new Set(['unix_socket', 'auth_socket', 'socket', 'nologin']);
const NATIVE_PLUGINS = new Set(['mysql_native_password']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'localhost.localdomain']);

function userKey(user: string, host: string): string {
  return `${user.toLowerCase()}\u0000${host.toLowerCase()}`;
}

function summarizePrivileges(data: SecurityData): Map<string, UserPrivilegeSummary> {
  const map = new Map<string, UserPrivilegeSummary>();
  for (const summary of data.privilegeSummaries) {
    map.set(userKey(summary.user, summary.host), summary);
  }
  return map;
}

export function runSecurityRules(data: SecurityData): Finding[] {
  const findings: Finding[] = [];
  const privileges = summarizePrivileges(data);
  const knownUsers = new Set<string>();

  const add = (
    ruleId: string,
    title: string,
    severity: Finding['severity'],
    message: string,
    recommendation: string,
    user: string,
    host: string,
    evidence?: string,
  ): void => {
    findings.push(
      createFinding({
        ruleId,
        title,
        severity,
        category: 'security',
        message,
        recommendation,
        evidence,
        line: null,
        object: { user, host },
        source: 'rule',
        confidence: 'high',
      }),
    );
  };

  for (const user of data.users) {
    knownUsers.add(userKey(user.user, user.host));
    const label = `'${user.user}'@'${user.host}'`;
    const summary = privileges.get(userKey(user.user, user.host));

    if (user.user === '') {
      add(
        'security.anonymous-user',
        'Anonymous MySQL account',
        'critical',
        'An anonymous account can connect without a meaningful username.',
        `Drop it: DROP USER ''@'${user.host}';`,
        user.user,
        user.host,
        label,
      );
    }

    if (
      user.user !== '' &&
      !user.passwordSet &&
      !SOCKET_PLUGINS.has(user.plugin.toLowerCase())
    ) {
      add(
        'security.empty-password',
        'Account has an empty password',
        'critical',
        `${label} can authenticate without a password.`,
        'Set a strong password immediately, or switch to a local socket plugin where appropriate.',
        user.user,
        user.host,
        `plugin=${user.plugin || 'unknown'}`,
      );
    }

    if (user.user.toLowerCase() === 'root' && !LOCAL_HOSTS.has(user.host.toLowerCase())) {
      add(
        'security.root-remote',
        'Root account can connect remotely',
        'critical',
        `Root is allowed from host '${user.host}', which exposes the highest-privilege account to the network.`,
        "Restrict root to localhost and create a separate least-privilege account for remote access.",
        user.user,
        user.host,
        label,
      );
    }

    if (user.host.includes('%') || user.host === '*') {
      add(
        'security.wildcard-host',
        'Account uses a wildcard host',
        user.user.toLowerCase() === 'root' ? 'critical' : 'high',
        `${label} matches connections from any host.`,
        'Replace the wildcard with the specific hosts or subnets that need access.',
        user.user,
        user.host,
        label,
      );
    }

    if (user.grantPriv || summary?.grantOption) {
      add(
        'security.grant-option',
        'Account can grant privileges to others',
        'high',
        `${label} has GRANT OPTION and can delegate privileges.`,
        'Remove GRANT OPTION unless this is a dedicated administrative account.',
        user.user,
        user.host,
        'GRANT OPTION',
      );
    }

    if (user.superPriv) {
      add(
        'security.super-privilege',
        'Account has SUPER privilege',
        'high',
        `${label} has SUPER, which bypasses many server safeguards.`,
        'Remove SUPER and grant only the specific privileges required.',
        user.user,
        user.host,
        'SUPER',
      );
    }
    if (user.filePriv) {
      add(
        'security.file-privilege',
        'Account has FILE privilege',
        'high',
        `${label} can read or write files on the MySQL server.`,
        'Remove FILE unless the account genuinely needs server-side file import/export.',
        user.user,
        user.host,
        'FILE',
      );
    }
    if (user.processPriv) {
      add(
        'security.process-privilege',
        'Account can inspect all sessions',
        'medium',
        `${label} has PROCESS and can read other sessions' queries.`,
        'Restrict PROCESS to monitoring accounts.',
        user.user,
        user.host,
        'PROCESS',
      );
    }
    if (user.shutdownPriv) {
      add(
        'security.shutdown-privilege',
        'Account can shut down the server',
        'medium',
        `${label} has SHUTDOWN privilege.`,
        'Remove SHUTDOWN from application accounts.',
        user.user,
        user.host,
        'SHUTDOWN',
      );
    }
    if (user.createUserPriv) {
      add(
        'security.create-user-privilege',
        'Account can create users',
        'medium',
        `${label} can create or alter MySQL accounts.`,
        'Restrict account management to dedicated administrative users.',
        user.user,
        user.host,
        'CREATE USER',
      );
    }

    if (summary && summary.privileges.length >= 20) {
      add(
        'security.broad-global-privileges',
        'Account has broad global privileges',
        'high',
        `${label} holds ${summary.privileges.length} global privileges.`,
        'Review the account and reduce it to the minimum required set.',
        user.user,
        user.host,
        summary.privileges.slice(0, 30).join(', '),
      );
    }

    const plugin = user.plugin.toLowerCase();
    if (plugin.includes('old_password')) {
      add(
        'security.old-password-plugin',
        'Account uses an obsolete password plugin',
        'critical',
        `${label} uses ${user.plugin}, which is insecure and deprecated.`,
        'Migrate the account to a modern authentication plugin and rotate the password.',
        user.user,
        user.host,
        `plugin=${user.plugin}`,
      );
    } else if (NATIVE_PLUGINS.has(plugin) && user.passwordSet) {
      add(
        'security.native-password-plugin',
        'Account uses mysql_native_password',
        'medium',
        `${label} uses ${user.plugin}. Newer MySQL versions default to a stronger plugin.`,
        'Consider caching_sha2_password (MySQL 8) or ed25519 (MariaDB) after verifying client support.',
        user.user,
        user.host,
        `plugin=${user.plugin}`,
      );
    }
  }

  for (const definer of data.definers) {
    const normalized = definer.replace(/`/g, '');
    const [userPart, hostPart] = normalized.split('@');
    if (!userPart) continue;
    const key = userKey(userPart, hostPart ?? '');
    if (knownUsers.has(key)) continue;
    findings.push(
      createFinding({
        ruleId: 'security.invalid-definer',
        title: 'Object definer does not exist',
        severity: 'medium',
        category: 'security',
        message: `A routine or view is defined by \`${definer}\`, but that account was not found.`,
        recommendation:
          'Recreate the object with a valid, minimally privileged definer, or create the missing account.',
        evidence: definer,
        object: { user: userPart, host: hostPart ?? undefined },
        source: 'rule',
        confidence: 'medium',
      }),
    );
  }

  return findings;
}
