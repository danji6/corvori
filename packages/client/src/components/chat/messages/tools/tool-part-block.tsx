import {
  ASK_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  EDIT_PLAN_TOOL_NAME,
  EDIT_TODO_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  LIST_SKILLS_TOOL_NAME,
  SHELL_OUTPUT_TOOL_NAME,
  SHELL_TOOL_NAME,
  TASK_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WRITE_PLAN_TOOL_NAME,
  WRITE_TODO_TOOL_NAME,
  YIELD_TOOL_NAME,
} from '@cv/core/const'
import type { ToolUIPart } from 'ai'

import { ToolBlock } from '../tool-block'
import { FileChangeBlock } from './file-change-block'
import { ListSkillsBlock } from './list-skills-block'
import { PlanBlock } from './plan-block'
import { QuestionBlock } from './question-block'
import { ShellBlock } from './shell-block'
import { ShellGroupBlock } from './shell-group-block'
import { SubagentBlock } from './subagent-block'
import { EditTodoBlock, WriteTodoBlock } from './todo-block'
import { WebFetchBlock } from './web-fetch-block'
import { YieldBlock } from './yield-block'

export type ToolRendererProps = {
  part: ToolUIPart
  messageId: string
  forceError?: boolean
}

export function ToolPartBlock(props: ToolRendererProps) {
  switch (props.part.type.slice('tool-'.length)) {
    case WRITE_FILE_TOOL_NAME:
    case EDIT_FILE_TOOL_NAME:
      return <FileChangeBlock {...props} />
    case SHELL_TOOL_NAME:
      return (
        <ShellGroupBlock
          parts={[props.part]}
          messageId={props.messageId}
          toolErrors={props.forceError ? [props.part.toolCallId] : undefined}
        />
      )
    case SHELL_OUTPUT_TOOL_NAME:
      return <ShellBlock {...props} />
    case WEB_FETCH_TOOL_NAME:
      return <WebFetchBlock {...props} />
    case LIST_SKILLS_TOOL_NAME:
      return <ListSkillsBlock {...props} />
    case TASK_TOOL_NAME:
      return <SubagentBlock {...props} />
    case WRITE_PLAN_TOOL_NAME:
    case EDIT_PLAN_TOOL_NAME:
    case ENTER_PLAN_MODE_TOOL_NAME:
    case EXIT_PLAN_MODE_TOOL_NAME:
      return <PlanBlock {...props} />
    case WRITE_TODO_TOOL_NAME:
      return <WriteTodoBlock {...props} />
    case EDIT_TODO_TOOL_NAME:
      return <EditTodoBlock {...props} />
    case ASK_TOOL_NAME:
      return <QuestionBlock {...props} />
    case YIELD_TOOL_NAME:
      return <YieldBlock {...props} />
    default:
      return <ToolBlock {...props} />
  }
}
