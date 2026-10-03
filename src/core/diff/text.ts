export const splitLines = (text: string): string[] => {
  if (text === "") {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
};
