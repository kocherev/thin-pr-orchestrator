export function splitNotes(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}
