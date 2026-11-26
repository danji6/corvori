import { cn } from '@/lib/utils'
import type { TodoItem, TodoStatus } from '@cv/convex/validators/todos'
import { TODO_EDIT_STATUSES, type TodoEditStatus } from '@cv/core/const'
import type { ToolUIPart } from 'ai'
import type { LucideIcon } from 'lucide-react'
import { CircleCheckIcon, CircleDotIcon, CircleIcon } from 'lucide-react'

import { ToolBlock } from '../tool-block'
import { ToolShell } from './tool-shell'

const STATUS_ICONS: Record<TodoStatus, LucideIcon> = {
  pending: CircleIcon,
  in_progress: CircleDotIcon,
  completed: CircleCheckIcon,
}

export function countCompleted(items: TodoItem[]) {
  return items.filter((item) => item.status === 'completed').length
}

/** Compact todo checklist, shared by the tool block and the live widget. */
export function TodoList({
  items,
  className,
}: {
  items: TodoItem[]
  className?: string
}) {
  return (
    <ul className={cn('flex flex-col gap-1', className)}>
      {items.map((item, index) => {
        const Icon = STATUS_ICONS[item.status]
        const completed = item.status === 'completed'
        return (
          <li key={index} className="flex items-start gap-1.5 text-xs">
            <Icon
              className={cn(
                'mt-px size-3.5 shrink-0',
                completed
                  ? 'text-muted-foreground'
                  : item.status === 'in_progress' && 'text-primary',
              )}
            />
            <span
              className={cn(completed && 'text-muted-foreground line-through')}
            >
              {item.content}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

type TodoBlockProps = {
  part: ToolUIPart
  messageId: string
  forceError?: boolean
}

function TodoToolShell({
  items,
  label,
  ...props
}: TodoBlockProps & { items: TodoItem[]; label: string }) {
  return (
    <ToolShell
      data-slot="todo-block"
      {...props}
      label={
        <span className="text-foreground font-medium">
          {label}
          {items.length > 0 && (
            <span className="text-muted-foreground font-normal">
              {' '}
              ({items.length})
            </span>
          )}
        </span>
      }
    >
      {items.length > 0 && (
        <TodoList items={items} className="chat-tool-list" />
      )}
    </ToolShell>
  )
}

export function WriteTodoBlock(props: TodoBlockProps) {
  const input = props.part.input as { todos?: unknown } | null | undefined
  const todos = input?.todos

  const todosAreStrings =
    Array.isArray(todos) && todos.every((todo) => typeof todo === 'string')
  if (!todosAreStrings) return <ToolBlock {...props} />

  const items = todos.map<TodoItem>((content) => ({
    content,
    status: 'pending',
  }))
  const clearing = todos.length === 0 && props.part.state !== 'input-streaming'

  return (
    <TodoToolShell
      {...props}
      items={items}
      label={clearing ? 'Clear todos' : 'Write todos'}
    />
  )
}

type TodoEditInput = { task: string; status: TodoEditStatus }

function isTodoEdit(input: unknown): input is TodoEditInput {
  if (typeof input !== 'object' || input === null) return false

  const { task, status } = input as { task?: unknown; status?: unknown }
  return (
    typeof task === 'string' &&
    typeof status === 'string' &&
    Object.hasOwn(TODO_EDIT_STATUSES, status)
  )
}

export function EditTodoBlock(props: TodoBlockProps) {
  const input = props.part.input as { edits?: unknown } | null | undefined
  const edits = input?.edits
  if (!Array.isArray(edits) || !edits.every(isTodoEdit)) {
    return <ToolBlock {...props} />
  }

  const items = edits.map(({ task, status }) => ({
    content: task,
    status: TODO_EDIT_STATUSES[status],
  }))

  return <TodoToolShell {...props} items={items} label="Update todos" />
}
