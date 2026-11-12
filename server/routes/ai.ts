import { Router } from 'express';
import { z } from 'zod';
import type { AiChatRequest } from '../../shared/types';
import {
  createProvider,
  deleteProvider,
  getProviderApiKey,
  getProviderRuntime,
  listProviders,
  resolveProvider,
  setDefaultProvider,
  setProviderModels,
  updateProvider,
} from '../store/providers';
import { listModels, testProvider } from '../ai';
import { runAiChat } from '../ai/analyze';
import {
  assistantSchema,
  buildAssistantMessages,
  challengeSchemaIdentifiers,
  CHALLENGE_GUARD_MESSAGE,
  runAssistant,
  screenChallengeAnswer,
  type AssistantQuestionView,
} from '../ai/assistant';
import {
  applyToolGovernance,
  buildCoachTools,
  buildWorkspaceTools,
  type AgentToolContext,
} from '../ai/agent-tools';
import { buildMcpTools, listMcpTools } from '../ai/agent-mcp';
import { AGENT_TOOLS } from '../../shared/agent-tools';
import { getSettings } from '../store/settings';
import {
  deleteConversation,
  findConversation,
  saveConversationTurns,
} from '../store/conversations';
import { runAgentTurn, type AgentEvent } from '../ai/agent';
import { openSse } from '../sse';
import { getDatabaseScope } from '../db/scope';
import { assertProfileAssigned, currentUser, requireAdmin, sandboxScopeOverride } from '../auth';
import { getPracticeSet } from '../store/practice';
import { getCachedServerInfo } from '../db/manager';
import { AppError } from '../errors';
import { asyncHandler, param, parseBody } from './util';

const ProviderSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['openai', 'anthropic', 'google']),
  baseUrl: z.string().url().max(1_000),
  chatPath: z.string().max(1_000).optional(),
  modelsPath: z.string().max(1_000).optional(),
  model: z.string().min(1).max(200),
  apiKey: z.string().max(8_000).optional(),
  clearApiKey: z.boolean().optional(),
  authHeader: z.string().max(100).optional(),
  authPrefix: z.string().max(100).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(16).max(128_000).optional(),
  streaming: z.boolean().optional(),
  thinkingEnabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

const ChatSchema = z.object({
  providerId: z.string().min(1).max(200),
  model: z.string().max(200).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(50_000),
      }),
    )
    .min(1)
    .max(50),
  context: z
    .object({
      sql: z.string().max(200_000).optional(),
      database: z.string().max(200).nullable().optional(),
      profileId: z.string().max(200).nullable().optional(),
      includeSchema: z.boolean().optional(),
    })
    .optional(),
});

const AssistantSchema = z.object({
  mode: z.enum(['workspace', 'challenge']),
  providerId: z.string().min(1).max(200),
  model: z.string().max(200).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(50_000),
      }),
    )
    .min(1)
    .max(50),
  context: z
    .object({
      sql: z.string().max(200_000).optional(),
      database: z.string().max(200).nullable().optional(),
      profileId: z.string().max(200).nullable().optional(),
      includeSchema: z.boolean().optional(),
      question: z
        .object({
          setId: z.string().min(1).max(200),
          questionId: z.string().min(1).max(200),
        })
        .optional(),
    })
    .optional(),
});

export const aiRouter = Router();

aiRouter.get(
  '/providers',
  asyncHandler(async (req, res) => {
    // The provider list carries the billing configuration of the installation.
    requireAdmin(req);
    res.json({ data: await listProviders() });
  }),
);

aiRouter.post(
  '/providers',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const body = parseBody(ProviderSchema, req);
    res.status(201).json({ data: await createProvider(body) });
  }),
);

aiRouter.put(
  '/providers/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const body = parseBody(ProviderSchema, req);
    res.json({ data: await updateProvider(param(req, 'id'), body) });
  }),
);

aiRouter.delete(
  '/providers/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    await deleteProvider(param(req, 'id'));
    res.json({ data: { deleted: true } });
  }),
);

aiRouter.post(
  '/providers/:id/default',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    res.json({ data: await setDefaultProvider(param(req, 'id')) });
  }),
);

aiRouter.post(
  '/providers/:id/test',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = param(req, 'id');
    const provider = await getProviderRuntime(id);
    const apiKey = await getProviderApiKey(id);
    const result = await testProvider(provider, apiKey);
    if (result.ok && result.models.length > 0) {
      await setProviderModels(id, result.models);
    }
    res.json({ data: result });
  }),
);

aiRouter.get(
  '/providers/:id/models',
  asyncHandler(async (req, res) => {
    // Listing the models spends the administrator's key and writes the result
    // back into the store, so it is an administrator action.
    requireAdmin(req);
    const id = param(req, 'id');
    const provider = await getProviderRuntime(id);
    const apiKey = await getProviderApiKey(id);
    const models = await listModels(provider, apiKey);
    if (models.length > 0) await setProviderModels(id, models);
    res.json({ data: { models } });
  }),
);

aiRouter.post(
  '/chat',
  asyncHandler(async (req, res) => {
    // The chat runs on the administrator's provider key and spends its quota.
    requireAdmin(req);
    const body = parseBody(ChatSchema, req) as AiChatRequest;
    const resolved = await resolveProvider(body.providerId);
    const provider = body.model?.trim()
      ? { ...resolved.public, model: body.model.trim() }
      : resolved.public;

    const sse = openSse(req, res);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    sse.send('meta', {
      providerId: provider.id,
      providerName: provider.name,
      model: provider.model,
      streaming: provider.streaming,
    });
    try {
      const result = await runAiChat(
        body,
        provider,
        resolved.apiKey,
        (text) => sse.send('delta', { text }),
        controller.signal,
        // The chat can read a connection's schema, so it must be evaluated
        // against the caller's scope rather than the profile's own scope.
        body.context?.profileId
          ? { scopeOverride: sandboxScopeOverride(req.user, body.context.profileId) }
          : {},
      );
      sse.send('result', { text: result.text, usage: result.usage });
      sse.send('done', {});
    } catch (error) {
      sse.send('error', {
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string }).code ?? 'AI_ERROR',
      });
    } finally {
      sse.close();
    }
  }),
);

/**
 * The assistant behind the floating action button.
 *
 * `workspace` is the full-capability engineer that works beside the editor.
 * `challenge` is the tutor inside the practice lab: it may explain the
 * challenge, but it must never hand over the answer.
 *
 * The challenge context is addressed by id, never by text. The server loads
 * the authoritative question, so a client cannot rewrite the prompt, and the
 * reference solution is read here for screening only — it is never part of
 * the provider messages.
 */
aiRouter.post(
  '/assist',
  asyncHandler(async (req, res) => {
    const body = parseBody(AssistantSchema, req);
    const user = currentUser(req);
    const profileId = body.context?.profileId?.trim() || null;
    if (profileId) assertProfileAssigned(req, profileId);

    const resolved = await resolveProvider(body.providerId);
    const provider = body.model?.trim()
      ? { ...resolved.public, model: body.model.trim() }
      : resolved.public;
    const scopeOverride = profileId ? sandboxScopeOverride(user, profileId) : undefined;

    let sql: string | null = null;
    let database: string | null;
    let question: AssistantQuestionView | null = null;
    let referenceSql: string | null = null;
    let identifiers = { tables: [] as string[], columns: [] as string[] };
    let schemaTables: string[] | undefined;

    if (body.mode === 'challenge') {
      const reference = body.context?.question;
      if (!reference) {
        throw new AppError('VALIDATION', 'A challenge reference is required.', 400);
      }
      const set = await getPracticeSet(reference.setId);
      if (!set) {
        throw new AppError('PRACTICE_SET_NOT_FOUND', 'That challenge set no longer exists.', 404);
      }
      if (profileId && set.profileId !== profileId) {
        throw new AppError(
          'PRACTICE_SET_FORBIDDEN',
          'This challenge set belongs to another connection.',
          403,
        );
      }
      if (user.role === 'member' && set.userId !== user.id) {
        throw new AppError(
          'PRACTICE_SET_FORBIDDEN',
          'This challenge set was generated by another account.',
          403,
        );
      }
      const stored = set.questions.find((item) => item.id === reference.questionId);
      if (!stored) {
        throw new AppError('PRACTICE_QUESTION_NOT_FOUND', 'That challenge no longer exists.', 404);
      }
      database = set.database;
      schemaTables = stored.schemaTables;
      question = {
        title: stored.title,
        type: stored.type,
        difficulty: stored.difficulty,
        topics: stored.topics,
        scenario: stored.scenario,
        hints: stored.hints,
        schemaTables: stored.schemaTables,
        // The broken query is the input of a fix-query challenge, so it is
        // part of the prompt. The reference solution never is.
        brokenSql: stored.type === 'fix-query' ? stored.brokenSql : null,
      };
      // Read for the guard only. It never reaches the provider messages.
      referenceSql = stored.referenceSql;
    } else {
      sql = body.context?.sql ?? null;
      database = body.context?.database ?? null;
    }

    const schema =
      profileId && database
        ? await assistantSchema({
            profileId,
            database,
            tableFilter: schemaTables,
            scopeOverride,
          })
        : { text: '', tables: [] };

    if (body.mode === 'challenge') {
      identifiers = challengeSchemaIdentifiers(schema.tables);
    }

    // The agent loop needs a live connection to run tools against and a
    // streaming provider. The workspace agent gets the full toolkit; the
    // challenge coach gets the structure-only set and its streamed text is
    // screened by the guard before release (below).
    const agentEligible = provider.streaming === true && profileId != null && database != null;
    let tools = null;
    if (agentEligible && profileId && database) {
      // Server-wide tools (slow log, security audit) exist only when the
      // connection allows them — the same gate the metrics/security routes use.
      const scope = await getDatabaseScope(profileId, scopeOverride);
      const settings = await getSettings();
      const toolCtx: AgentToolContext = {
        profileId,
        database,
        scopeOverride,
        userId: user.id,
        serverWide: user.role === 'admin' && scope.mode === 'all' && scope.serverWideInsights,
        userRole: user.role === 'member' ? 'member' : 'admin',
        // The coach sees only the challenge's own tables.
        tableFilter: body.mode === 'challenge' ? (schemaTables ?? undefined) : undefined,
      };
      const base =
        body.mode === 'challenge' ? buildCoachTools(toolCtx) : buildWorkspaceTools(toolCtx);
      // Configured MCP servers are administrator-only: separate subprocesses do
      // not isolate the external resource behind an MCP server. A server that
      // fails to start is skipped, never fatal. The coach never gets MCP tools.
      const mcp =
        body.mode === 'workspace' &&
        user.role === 'admin' &&
        settings.mcpServers &&
        settings.mcpServers.length > 0
          ? await buildMcpTools(settings.mcpServers, { userId: user.id })
          : {
              definitions: [],
              handlers: new Map<string, (args: Record<string, unknown>) => Promise<string>>(),
            };
      tools = applyToolGovernance(
        {
          definitions: [...base.definitions, ...mcp.definitions],
          handlers: new Map([...base.handlers, ...mcp.handlers]),
        },
        settings.disabledAgentTools ?? [],
      );
    }

    const sse = openSse(req, res);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    sse.send('meta', {
      providerId: provider.id,
      providerName: provider.name,
      model: provider.model,
      streaming: provider.streaming && body.mode === 'workspace',
      mode: body.mode,
      agent: agentEligible,
      tools: tools ? tools.definitions.map((tool) => tool.name) : [],
    });

    if (tools && profileId && database) {
      const promptMessages = buildAssistantMessages({
        mode: body.mode,
        messages: body.messages,
        sql,
        database,
        server: getCachedServerInfo(profileId),
        schemaText: schema.text,
        question: body.mode === 'challenge' ? question : undefined,
      });
      const emitAgentEvent = (event: AgentEvent): void => {
        if (event.type === 'thinking') {
          sse.send('thinking', { text: event.text });
        } else if (event.type === 'delta') {
          sse.send('delta', { text: event.text });
        } else if (event.type === 'tool_call') {
          sse.send('tool_call', {
            id: event.id,
            name: event.name,
            arguments: event.arguments,
          });
        } else {
          sse.send('tool_result', {
            id: event.id,
            name: event.name,
            ok: event.ok,
            output: event.output,
            error: event.error ?? null,
            durationMs: event.durationMs,
          });
        }
      };
      // In challenge mode the answer text must pass the guard before anyone
      // reads it, so deltas and reasoning are held back; tool activity still
      // streams live because it carries no answer.
      const challengeMode = body.mode === 'challenge';
      const buffered: AgentEvent[] = [];
      const emitForMode = (event: AgentEvent): void => {
        if (challengeMode && (event.type === 'delta' || event.type === 'thinking')) {
          buffered.push(event);
          return;
        }
        emitAgentEvent(event);
      };
      try {
        const result = await runAgentTurn(
          {
            provider,
            apiKey: resolved.apiKey,
            promptMessages,
            tools,
            signal: controller.signal,
          },
          emitForMode,
        );
        if (challengeMode) {
          const screened = screenChallengeAnswer({
            text: result.text,
            referenceSql,
            identifiers,
          });
          if (!screened.safe) {
            sse.send('delta', { text: CHALLENGE_GUARD_MESSAGE });
            sse.send('result', {
              text: CHALLENGE_GUARD_MESSAGE,
              usage: result.usage,
              guarded: screened.reason ?? 'solution-detected',
              toolCalls: result.toolCalls,
            });
            sse.send('done', {});
            return;
          }
          for (const event of buffered) emitAgentEvent(event);
        }
        sse.send('result', {
          text: result.text,
          usage: result.usage,
          guarded: null,
          toolCalls: result.toolCalls,
        });
        sse.send('done', {});
      } catch (error) {
        sse.send('error', {
          message: error instanceof Error ? error.message : String(error),
          code: (error as { code?: string }).code ?? 'AI_ERROR',
        });
      } finally {
        sse.close();
      }
      return;
    }

    try {
      const result = await runAssistant(
        {
          mode: body.mode,
          messages: body.messages,
          sql,
          database,
          server: profileId ? getCachedServerInfo(profileId) : null,
          schemaText: schema.text,
          question,
          referenceSql,
          identifiers,
          provider,
          apiKey: resolved.apiKey,
        },
        (text) => sse.send('delta', { text }),
        controller.signal,
        (text) => sse.send('thinking', { text }),
      );
      sse.send('result', {
        text: result.text,
        usage: result.usage,
        guarded: result.guarded ?? null,
      });
      sse.send('done', {});
    } catch (error) {
      sse.send('error', {
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string }).code ?? 'AI_ERROR',
      });
    } finally {
      sse.close();
    }
  }),
);

/* ------------------------------------------------------------------ */
/* Conversation persistence (silent restore)                           */
/* ------------------------------------------------------------------ */

const ConversationTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(8_000),
  thinking: z.string().max(32_000).optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string().max(200),
        name: z.string().max(60),
        arguments: z.record(z.string(), z.unknown()),
        status: z.enum(['running', 'complete', 'error']),
        output: z.string().max(8_000).optional(),
        error: z.string().max(2_000).optional(),
        durationMs: z.number().optional(),
      }),
    )
    .max(12)
    .optional(),
  usage: z
    .object({
      inputTokens: z.number().nullable(),
      outputTokens: z.number().nullable(),
      totalTokens: z.number().nullable(),
    })
    .nullable()
    .optional(),
});

const ConversationPutSchema = z.object({
  mode: z.enum(['workspace', 'challenge']),
  profileId: z.string().max(200).nullable().optional(),
  turns: z.array(ConversationTurnSchema).max(60),
});

aiRouter.get(
  '/conversations/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const record = await findConversation(param(req, 'id'), user.id);
    res.json({
      data: record
        ? {
            id: record.id,
            mode: record.mode,
            title: record.title,
            turns: record.turns,
            updatedAt: record.updatedAt,
          }
        : null,
    });
  }),
);

aiRouter.put(
  '/conversations/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(ConversationPutSchema, req);
    await saveConversationTurns({
      id: param(req, 'id'),
      userId: user.id,
      profileId: body.profileId ?? null,
      mode: body.mode,
      turns: body.turns,
    });
    res.json({ data: { saved: true } });
  }),
);

aiRouter.delete(
  '/conversations/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    await deleteConversation(param(req, 'id'), user.id);
    res.json({ data: { deleted: true } });
  }),
);

/* ------------------------------------------------------------------ */
/* Agent tool registry (for the admin governance UI)                   */
/* ------------------------------------------------------------------ */

aiRouter.get(
  '/agent/tools',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const settings = await getSettings();
    const statuses = settings.mcpServers?.length
      ? await listMcpTools(settings.mcpServers, { userId: req.user!.id })
      : [];
    res.json({
      data: {
        builtin: AGENT_TOOLS,
        mcp: statuses.map((status) => ({
          server: status.server,
          ok: status.ok,
          error: status.error ?? null,
          tools: status.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? null,
          })),
        })),
        disabled: settings.disabledAgentTools ?? [],
      },
    });
  }),
);
