import { APP_ID } from './const'

export const NOTIFICATION_ACTION = `${APP_ID}:notification-action`
export const NOTIFICATION_ACTION_ACK = `${APP_ID}:notification-action-ack`
export const NOTIFICATION_ACTION_CACHE = `${APP_ID}-notification-actions-v3`

export type NotificationApprovalAction = 'allow' | 'allow-session' | 'deny'

export type NotificationApprovalOption = {
  action: NotificationApprovalAction
  label: string
  description?: string
}

export type NotificationWorkerAction = {
  type: typeof NOTIFICATION_ACTION
  action: 'read' | 'show' | NotificationApprovalAction
  userId: string
  notificationId: string
  sessionId?: string
  taskRunId?: string
  requestId?: string
  openSession?: boolean
}

/** Opens a task result even if its original session has since been deleted. */
export function notificationPath(sessionId: string, taskRunId?: string) {
  return taskRunId
    ? '/tasks/runs/' + encodeURIComponent(taskRunId)
    : '/?id=' + encodeURIComponent(sessionId)
}

/** Prioritizes approval actions when the desktop platform limits button count. */
export function desktopApprovalActions(
  options: NotificationApprovalOption[],
  maxActions: number,
) {
  return options.slice(0, maxActions).map(({ action, label }) => ({
    action,
    title: label,
  }))
}
