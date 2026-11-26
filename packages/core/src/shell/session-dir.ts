/** A literal suffix of a quoted SESSION_DIR path operand. */
export function isSessionDirOperand(value: string): boolean {
  return (
    value.length > 0 && !value.startsWith('/') && !/[\\$`"\p{Cc}]/u.test(value)
  )
}
