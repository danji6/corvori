'use node'

import {
  ASK_TOOL_NAME,
  ATTACH_FILE_TOOL_NAME,
  CALL_MCP_TOOL_NAME,
  COPY_ATTACHMENT_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  EDIT_PLAN_TOOL_NAME,
  EDIT_TODO_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  KILL_SHELL_TOOL_NAME,
  LIST_SKILLS_TOOL_NAME,
  MCP_PROTOCOL_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  READ_MCP_OUTPUT_TOOL_NAME,
  READ_SKILL_TOOL_NAME,
  SEARCH_MCP_TOOLS_NAME,
  SHELL_OUTPUT_TOOL_NAME,
  SHELL_TOOL_NAME,
  TASK_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WRITE_PLAN_TOOL_NAME,
  WRITE_TODO_TOOL_NAME,
  YIELD_TOOL_NAME,
} from '@cv/core/const'
import { READ_ATTACHMENT_TOOL_NAME } from '@cv/core/const'
import { hasFilesystemTools } from '@cv/core/tool-capabilities'
import type { WireToolCall } from '@cv/core/tool-dispatch'
import type { AgentAutoApprove } from '@cv/core/types/agents'
import type { ToolApprovals } from '@cv/core/types/tools'
import type { ToolSet } from 'ai'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import { error } from '../../errors'
import { sharedSessionId } from '../../lib/subagent'
import { mergeToolApprovals } from '../../lib/tool/approval'
import type { StreamExecutionArgs } from '../../validators/streams'
import type { Session } from '../session/types'
import { createAskTool } from './ask'
import { createAttachmentTransferTool } from './attachmentTransfers'
import { createReadAttachmentTool } from './attachments'
import type { PlanToolContext, WorkspaceToolContext } from './context'
import type { FilesystemCall } from './executionApprovals'
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
} from './files'
import { guardFilesystemTool } from './filesystemGuard'
import type { McpManifestEntry, ToolManifest } from './manifest'
import { createExternalMcpTool } from './mcp'
import { guardMcpApproval } from './mcpApproval'
import { createMcpBrokerTools } from './mcpBroker'
import type { McpOperationContext } from './mcpOperation'
import { createMcpProtocolTools } from './mcpProtocol'
import {
  createEditPlanTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createWritePlanTool,
  isPlanMode,
  withPlanModeReminders,
} from './plan'
import { filesystemWorkspace } from './sessionFilesystem'
import { EMPTY_TOOL_RESOURCES, type ToolResources } from './settings'
import {
  createKillShellTool,
  createShellOutputTool,
  createShellTool,
} from './shellTools'
import { createListSkillsTool, createReadSkillTool } from './skills'
import type { SkillsContext } from './skills'
import { createTaskTool } from './task'
import { createEditTodoTool, createWriteTodoTool } from './todo'
import { createWebFetchTool, createWebSearchTool } from './web'
import { createYieldTool } from './yieldTurn'

/** Session data the tool builder needs. */
export type ToolSession = Pick<Session, '_id' | 'workspace' | 'parent'> & {
  toolApprovals?: ToolApprovals
}

export type ToolBuildOptions = {
  wireCalls?: Map<string, WireToolCall>
  omitMcpMedia?: boolean
  ctx?: ActionCtx
  /** The agent's own approvals, merged into the session's. */
  autoApprove?: AgentAutoApprove
  /** Message this turn writes into. */
  messageId?: Id<'messages'>
  messageCreatedAt?: number
  /** Agent and invoker a backgrounded shell job reports back as. */
  agentId?: Id<'agents'>
  invokedBy?: Id<'users'>
  execution?: StreamExecutionArgs
  taskInvocation?: boolean
  shellWindowDeadline?: number
}

/**
 * Builds execution behavior for a resolved manifest. Session tools freeze its
 * provider shape separately.
 */
export async function getEnabledTools(
  manifest: ToolManifest,
  session?: ToolSession,
  resources?: ToolResources | null,
  options?: ToolBuildOptions,
): Promise<ToolSet> {
  const ctx = options?.ctx
  const sessionId = session ? sharedSessionId(session) : undefined
  const execution = options?.execution
  const taskApprovals =
    options?.taskInvocation && ctx && execution
      ? (call?: FilesystemCall) =>
          ctx.runQuery(internal.streams._getExecutionApprovals, {
            ...execution,
            call,
          })
      : undefined

  // Approvals can be remembered mid-turn
  const approvals = taskApprovals
    ? async () => (await taskApprovals()).approvals
    : session
      ? () => resolveApprovals(session, options)
      : undefined

  const workspace: WorkspaceToolContext | undefined =
    session && sessionId
      ? {
          sessionId,
          ownerId: session._id,
          messageId: options?.messageId,
          messageCreatedAt: options?.messageCreatedAt,
          workspaceId: session.workspace?.workspaceId ?? sessionId,
          workspace: hasFilesystemTools(manifest.names)
            ? filesystemWorkspace(session)
            : session.workspace,
          hasAgentHome: manifest.hasAgentHome ?? false,
          shell: manifest.shell,
          allowInteractiveShells:
            resources?.settings?.allowInteractiveShells ?? false,
          approvals,
          taskApprovals,
          // Plan mode can be entered or approved mid-turn
          isPlanMode: ctx ? () => isPlanMode(ctx, sessionId) : undefined,
          ...jobWatch(session, options),
          saveShellTerminal: ctx
            ? (output) =>
                ctx.runMutation(internal.shellJobs._saveTerminal, {
                  sessionId,
                  output,
                })
            : undefined,
          shellWindowDeadline: options?.shellWindowDeadline,
          bindShell:
            ctx && options?.messageId
              ? (jobId, toolCallId, command) =>
                  ctx.runMutation(internal.shellJobs._bindReference, {
                    sessionId,
                    jobId,
                    toolCallId,
                    command,
                    messageId: options.messageId!,
                  })
              : undefined,
          findShell: ctx
            ? (jobId) =>
                ctx.runQuery(internal.shellJobs._findReference, {
                  sessionId,
                  jobId,
                })
            : undefined,
          readShellPosition:
            ctx && options?.execution
              ? async (jobId, offset) => {
                  const position = await ctx.runQuery(
                    internal.shellOutputDeliveries._position,
                    {
                      ...options.execution!,
                      jobId,
                      offset,
                    },
                  )
                  if (!position) error('Shell output execution changed', 409)
                  return position
                }
              : undefined,
        }
      : undefined

  const planContext: PlanToolContext | undefined =
    ctx && sessionId ? { ctx, sessionId, approvals } : undefined

  const mcpByName = new Map((manifest.mcp ?? []).map((e) => [e.name, e]))
  const tools: ToolSet = {}

  for (const name of manifest.names) {
    const built = await createManifestTool(name, {
      manifest,
      mcpByName,
      resources: resources ?? EMPTY_TOOL_RESOURCES,
      workspace,
      skillsContext:
        ctx && options?.execution
          ? {
              ctx,
              execution: options.execution,
              toolNames: manifest.names,
            }
          : undefined,
      planContext,
      execution: options?.execution,
      mcpApprovals: approvals,
      mcpOperation:
        ctx && options?.execution && options.messageId
          ? {
              ctx,
              wireCalls: options.wireCalls,
              execution: options.execution,
              messageId: options.messageId,
              omitMedia: options.omitMcpMedia,
              canReadOutput: manifest.names.includes(READ_MCP_OUTPUT_TOOL_NAME),
            }
          : undefined,
      mcpFailed: ctx
        ? async (runtimeId, key, reason) => {
            await ctx.runMutation(internal.mcp._updateRuntimeStatus, {
              runtimeId,
              key,
              state: 'lost',
              reason,
            })
          }
        : undefined,
      mcpConnected: ctx
        ? async (runtimeId, key, bootId, generation, initialization) =>
            ctx.runMutation(internal.mcp._connected, {
              runtimeId,
              key,
              bootId,
              generation,
              initialization,
            })
        : undefined,
      mcpExecution:
        ctx && sessionId && options?.agentId
          ? (serverKey, toolName) =>
              ctx.runMutation(internal.mcp._getExecution, {
                sessionId: session!._id,
                agentId: options.agentId!,
                serverKey,
                toolName,
                ...options?.execution,
              })
          : undefined,
    })
    if (built)
      tools[name] = guardFilesystemTool(name, built, workspace, options)
  }

  return withPlanModeReminders(tools, planContext)
}

/**
 * Watch callbacks for jobs that outlive their tool call. They are addressed by
 * the session that owns the turn, which is the one their report wakes.
 */
function jobWatch(
  session: ToolSession,
  options?: ToolBuildOptions,
): Pick<WorkspaceToolContext, 'watchJob' | 'releaseJob'> {
  const { ctx, agentId, invokedBy } = options ?? {}
  if (!ctx || !agentId || !invokedBy) return {}

  return {
    watchJob: async (job) => {
      await ctx.runMutation(internal.shellJobs._register, {
        sessionId: session._id,
        agentId,
        invokedBy,
        ...job,
        execution: options?.execution,
      })
    },
    releaseJob: async (jobId) => {
      await ctx.runMutation(internal.shellJobs._release, {
        sessionId: session._id,
        jobId,
      })
    },
  }
}

/**
 * Reads the main session's live approval policy for every agent in the task.
 * Falls back to the caller's snapshot when there is no ctx.
 */
async function resolveApprovals(
  session: ToolSession,
  options?: ToolBuildOptions,
): Promise<ToolApprovals | undefined> {
  const live = options?.ctx
    ? await options.ctx.runQuery(internal.sessions._getApprovals, {
        sessionId: session._id,
      })
    : session.toolApprovals

  return mergeToolApprovals(live ?? undefined, options?.autoApprove)
}

type AnyTool = ToolSet[string]

type McpExecution = (
  serverKey: string,
  toolName?: string,
) => ReturnType<NonNullable<Parameters<typeof createExternalMcpTool>[2]>>

type BuildContext = {
  skillsContext?: SkillsContext
  manifest: ToolManifest
  mcpByName: Map<string, McpManifestEntry>
  resources: ToolResources
  workspace?: WorkspaceToolContext
  planContext?: PlanToolContext
  execution?: StreamExecutionArgs
  mcpFailed?: (
    runtimeId: Id<'mcpRuntimes'>,
    key: string,
    reason: string,
  ) => Promise<void>
  mcpApprovals?: () => Promise<ToolApprovals | undefined>
  mcpOperation?: McpOperationContext
  mcpConnected?: (
    runtimeId: Id<'mcpRuntimes'>,
    key: string,
    bootId: string,
    generation: string,
    initialization?: string,
  ) => Promise<boolean>
  mcpExecution?: McpExecution
}

/** Constructs one tool by its cached name. */
async function createManifestTool(
  name: string,
  build: BuildContext,
): Promise<AnyTool | undefined> {
  const { workspace, planContext } = build

  switch (name) {
    case MCP_PROTOCOL_TOOL_NAME:
    case READ_MCP_OUTPUT_TOOL_NAME:
    case SEARCH_MCP_TOOLS_NAME:
    case CALL_MCP_TOOL_NAME: {
      if (!build.mcpOperation || !build.mcpExecution) return undefined
      const create =
        name === MCP_PROTOCOL_TOOL_NAME || name === READ_MCP_OUTPUT_TOOL_NAME
          ? createMcpProtocolTools
          : createMcpBrokerTools
      const broker = await create({
        operation: build.mcpOperation,
        current: build.mcpExecution,
        connected: build.mcpConnected,
        approvals: build.mcpApprovals,
        failed: build.mcpFailed,
      })
      return guardMcpApproval((broker as Record<string, AnyTool>)[name])
    }
    case WEB_FETCH_TOOL_NAME:
      return createWebFetchTool()
    case WEB_SEARCH_TOOL_NAME:
      return createWebSearchTool(build.resources.settings)
    case COPY_ATTACHMENT_TOOL_NAME:
    case ATTACH_FILE_TOOL_NAME:
      if (!planContext || !build.execution) return undefined
      return createAttachmentTransferTool(
        name,
        planContext.ctx,
        build.execution,
      )
    case READ_ATTACHMENT_TOOL_NAME:
      return (
        planContext &&
        (createReadAttachmentTool(
          planContext.ctx,
          build.execution,
        ) as Promise<AnyTool>)
      )
    case READ_SKILL_TOOL_NAME:
      return build.skillsContext && createReadSkillTool(build.skillsContext)
    case LIST_SKILLS_TOOL_NAME:
      return build.skillsContext && createListSkillsTool(build.skillsContext)
    case READ_FILE_TOOL_NAME:
      return workspace && createReadFileTool(workspace)
    case WRITE_FILE_TOOL_NAME:
      return workspace && createWriteFileTool(workspace)
    case EDIT_FILE_TOOL_NAME:
      return workspace && createEditFileTool(workspace)
    // Streaming tools carry narrower generics than the ToolSet value type
    case SHELL_TOOL_NAME:
      return workspace && (createShellTool(workspace) as Promise<AnyTool>)
    case SHELL_OUTPUT_TOOL_NAME:
      return workspace && (createShellOutputTool(workspace) as Promise<AnyTool>)
    case KILL_SHELL_TOOL_NAME:
      return workspace && createKillShellTool(workspace)
    case WRITE_PLAN_TOOL_NAME:
      return planContext && createWritePlanTool(planContext)
    case EDIT_PLAN_TOOL_NAME:
      return planContext && createEditPlanTool(planContext)
    case ENTER_PLAN_MODE_TOOL_NAME:
      return planContext && createEnterPlanModeTool(planContext)
    case EXIT_PLAN_MODE_TOOL_NAME:
      return planContext && createExitPlanModeTool(planContext)
    case WRITE_TODO_TOOL_NAME:
      return planContext && createWriteTodoTool(planContext)
    case EDIT_TODO_TOOL_NAME:
      return planContext && createEditTodoTool(planContext)
    case ASK_TOOL_NAME:
      return createAskTool()
    case YIELD_TOOL_NAME:
      return createYieldTool()
    case TASK_TOOL_NAME:
      return createTaskTool(build.manifest.taskRoster ?? '')
  }

  const entry = build.mcpByName.get(name)
  if (!entry) return undefined

  const external = await createExternalMcpTool(
    entry,
    build.resources.mcpServers,
    build.mcpExecution
      ? () => build.mcpExecution!(entry.serverId, entry.toolName)
      : undefined,
    build.mcpConnected,
    build.mcpApprovals,
    build.mcpFailed,
    build.mcpOperation,
  )
  return guardMcpApproval(external)
}
