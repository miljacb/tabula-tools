/**
 * Atlas page names are the non-indented lines immediately followed by a `size:` field.
 * Region names are also non-indented, but the next field is `rotate`, `xy`, or `bounds`.
 * @param {string} atlasText
 * @returns {string[]}
 */
export function atlasPageNames(atlasText) {
  const lines = atlasText.split(/\r?\n/);
  /** @type {string[]} */
  const names = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^\s/.test(line)) continue;
    let next = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim()) {
        next = lines[j];
        break;
      }
    }
    if (/^\s*size\s*:/.test(next)) names.push(line.trim());
  }
  return names;
}
