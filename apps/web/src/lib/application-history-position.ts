/** Navigation API indices also cover entries created before this app loaded. */
export function applicationHistoryIndex(win: Window): number | null {
  const navigation = (win as Window & { navigation?: { currentEntry?: { index: number } | null } }).navigation
  const index = navigation?.currentEntry?.index
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : null
}
