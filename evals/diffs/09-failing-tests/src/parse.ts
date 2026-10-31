export function parseFlag(text: string): boolean | null {
  if (text === "TRUE") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  return null;
}
