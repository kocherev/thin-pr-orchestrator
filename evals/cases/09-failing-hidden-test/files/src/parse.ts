export function parseFlag(text: string): boolean | null {
  if (text === "true" || text === "True") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  return null;
}
