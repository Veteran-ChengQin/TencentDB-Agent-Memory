/** Build a canonical Git patch from per-file diffs captured by any harness. */
export function assembleTaskPatch(files: ReadonlyArray<{ diff?: string }>): string {
  const sections = files
    .map((file) => (file.diff ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
    .filter((diff) => diff.length > 0)
    .map((diff) => diff.replace(/\n+$/, ''));

  return sections.length > 0 ? `${sections.join('\n')}\n` : '';
}
