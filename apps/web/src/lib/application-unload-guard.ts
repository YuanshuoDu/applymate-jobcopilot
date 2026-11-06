export function guardApplicationUnload(event: BeforeUnloadEvent, pending: boolean): void {
  if (!pending) return
  event.preventDefault()
  event.returnValue = ''
}
