// Keep this helper in the sample tree.
export function parseFlag(text: string): boolean | null {
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  return null;
}
