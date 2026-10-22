import type { DbUser, Finding } from '../../../shared/types';
import type { SecurityData, UserPrivilegeSummary } from '../../db/security-audit';
import { defineRule, runRules, type Rule } from './descriptor';

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

export interface SecurityUserRuleInput {
  user: DbUser;
  summary: UserPrivilegeSummary | undefined;
  label: string;
}

export const SECURITY_USER_RULES: Rule<SecurityUserRuleInput>[] = [
  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.anonymous-user',
      title: 'Anonymous MySQL account',
      severity: 'critical',
      category: 'security',
    },
    ({ user, label }) =>
      user.user === ''
        ? {
            message: 'An anonymous account can connect without a meaningful username.',
            recommendation: `Drop it: DROP USER ''@'${user.host}';`,
            evidence: label,
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.empty-password',
      title: 'Account has an empty password',
      severity: 'critical',
      category: 'security',
    },
    ({ user, label }) =>
      user.user !== '' && !user.passwordSet && !SOCKET_PLUGINS.has(user.plugin.toLowerCase())
        ? {
            message: `${label} can authenticate without a password.`,
            recommendation:
              'Set a strong password immediately, or switch to a local socket plugin where appropriate.',
            evidence: `plugin=${user.plugin || 'unknown'}`,
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.root-remote',
      title: 'Root account can connect remotely',
      severity: 'critical',
      category: 'security',
    },
    ({ user, label }) =>
      user.user.toLowerCase() === 'root' && !LOCAL_HOSTS.has(user.host.toLowerCase())
        ? {
            message: `Root is allowed from host '${user.host}', which exposes the highest-privilege account to the network.`,
            recommendation:
              'Restrict root to localhost and create a separate least-privilege account for remote access.',
            evidence: label,
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.wildcard-host',
      title: 'Account uses a wildcard host',
      severity: 'high',
      category: 'security',
    },
    ({ user, label }) =>
      user.host.includes('%') || user.host === '*'
        ? {
            message: `${label} matches connections from any host.`,
            recommendation:
              'Replace the wildcard with the specific hosts or subnets that need access.',
            evidence: label,
            severity:
              user.user.toLowerCase() === 'root' ? ('critical' as const) : ('high' as const),
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.grant-option',
      title: 'Account can grant privileges to others',
      severity: 'high',
      category: 'security',
    },
    ({ user, summary, label }) =>
      user.grantPriv || summary?.grantOption
        ? {
            message: `${label} has GRANT OPTION and can delegate privileges.`,
            recommendation:
              'Remove GRANT OPTION unless this is a dedicated administrative account.',
            evidence: 'GRANT OPTION',
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.super-privilege',
      title: 'Account has SUPER privilege',
      severity: 'high',
      category: 'security',
    },
    ({ user, label }) =>
      user.superPriv
        ? {
            message: `${label} has SUPER, which bypasses many server safeguards.`,
            recommendation: 'Remove SUPER and grant only the specific privileges required.',
            evidence: 'SUPER',
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.file-privilege',
      title: 'Account has FILE privilege',
      severity: 'high',
      category: 'security',
    },
    ({ user, label }) =>
      user.filePriv
        ? {
            message: `${label} can read or write files on the MySQL server.`,
            recommendation:
              'Remove FILE unless the account genuinely needs server-side file import/export.',
            evidence: 'FILE',
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.process-privilege',
      title: 'Account can inspect all sessions',
      severity: 'medium',
      category: 'security',
    },
    ({ user, label }) =>
      user.processPriv
        ? {
            message: `${label} has PROCESS and can read other sessions' queries.`,
            recommendation: 'Restrict PROCESS to monitoring accounts.',
            evidence: 'PROCESS',
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.shutdown-privilege',
      title: 'Account can shut down the server',
      severity: 'medium',
      category: 'security',
    },
    ({ user, label }) =>
      user.shutdownPriv
        ? {
            message: `${label} has SHUTDOWN privilege.`,
            recommendation: 'Remove SHUTDOWN from application accounts.',
            evidence: 'SHUTDOWN',
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.create-user-privilege',
      title: 'Account can create users',
      severity: 'medium',
      category: 'security',
    },
    ({ user, label }) =>
      user.createUserPriv
        ? {
            message: `${label} can create or alter MySQL accounts.`,
            recommendation: 'Restrict account management to dedicated administrative users.',
            evidence: 'CREATE USER',
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.broad-global-privileges',
      title: 'Account has broad global privileges',
      severity: 'high',
      category: 'security',
    },
    ({ summary, label }) =>
      summary && summary.privileges.length >= 20
        ? {
            message: `${label} holds ${summary.privileges.length} global privileges.`,
            recommendation: 'Review the account and reduce it to the minimum required set.',
            evidence: summary.privileges.slice(0, 30).join(', '),
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.old-password-plugin',
      title: 'Account uses an obsolete password plugin',
      severity: 'critical',
      category: 'security',
    },
    ({ user, label }) =>
      user.plugin.toLowerCase().includes('old_password')
        ? {
            message: `${label} uses ${user.plugin}, which is insecure and deprecated.`,
            recommendation:
              'Migrate the account to a modern authentication plugin and rotate the password.',
            evidence: `plugin=${user.plugin}`,
          }
        : null,
  ),

  defineRule<SecurityUserRuleInput>(
    {
      id: 'security.native-password-plugin',
      title: 'Account uses mysql_native_password',
      severity: 'medium',
      category: 'security',
    },
    ({ user, label }) => {
      const plugin = user.plugin.toLowerCase();
      if (!NATIVE_PLUGINS.has(plugin) || !user.passwordSet) return null;
      return {
        message: `${label} uses ${user.plugin}. Newer MySQL versions default to a stronger plugin.`,
        recommendation:
          'Consider caching_sha2_password (MySQL 8) or ed25519 (MariaDB) after verifying client support.',
        evidence: `plugin=${user.plugin}`,
      };
    },
  ),
];

export interface SecurityDefinerRuleInput {
  definer: string;
  knownUsers: ReadonlySet<string>;
}

export const SECURITY_DEFINER_RULES: Rule<SecurityDefinerRuleInput>[] = [
  defineRule<SecurityDefinerRuleInput>(
    {
      id: 'security.invalid-definer',
      title: 'Object definer does not exist',
      severity: 'medium',
      category: 'security',
    },
    ({ definer, knownUsers }) => {
      const normalized = definer.replace(/`/g, '');
      const [userPart, hostPart] = normalized.split('@');
      if (!userPart) return null;
      if (knownUsers.has(userKey(userPart, hostPart ?? ''))) return null;
      return {
        message: `A routine or view is defined by \`${definer}\`, but that account was not found.`,
        recommendation:
          'Recreate the object with a valid, minimally privileged definer, or create the missing account.',
        evidence: definer,
        object: { user: userPart, host: hostPart ?? undefined },
        confidence: 'medium' as const,
      };
    },
  ),
];

export function runSecurityRules(data: SecurityData) {
  const privileges = summarizePrivileges(data);
  const knownUsers = new Set<string>();
  const findings = [];

  for (const user of data.users) {
    knownUsers.add(userKey(user.user, user.host));
    // Every account-level finding is anchored to the account it describes.
    const accountFindings = runRules(SECURITY_USER_RULES, {
      user,
      summary: privileges.get(userKey(user.user, user.host)),
      label: `'${user.user}'@'${user.host}'`,
    }).map((finding): Finding => ({
      ...finding,
      object: { user: user.user, host: user.host },
    }));
    findings.push(...accountFindings);
  }

  for (const definer of data.definers) {
    findings.push(...runRules(SECURITY_DEFINER_RULES, { definer, knownUsers }));
  }

  return findings;
}
