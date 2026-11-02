export function splitNotes(text: string): string[] {
  if (text.trim().length === 0) {
    return [];
  }
  return text.split("\n");
}
