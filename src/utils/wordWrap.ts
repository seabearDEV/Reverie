export function interpretEscapes(str: string): string {
  return str.replace(/\\([nt\\])/g, (_, ch: string) => {
    switch (ch) {
      case 'n': return '\n';
      case 't': return '\t';
      default: return ch;
    }
  });
}

// Matching the ESC control character is the whole point here (ANSI SGR codes).
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

/**
 * Slice a string to `maxVisible` visible characters, preserving ANSI
 * escape sequences intact. Returns [head, tail].
 */
function sliceVisible(str: string, maxVisible: number): [string, string] {
  let visible = 0;
  let i = 0;
  while (i < str.length && visible < maxVisible) {
    // Skip ANSI escape sequences without counting them
    if (str[i] === '\x1b' && str[i + 1] === '[') {
      const end = str.indexOf('m', i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    visible++;
    i++;
  }
  // Include any trailing ANSI codes that sit right at the split point
  while (i < str.length && str[i] === '\x1b' && str[i + 1] === '[') {
    const end = str.indexOf('m', i);
    if (end !== -1) {
      i = end + 1;
    } else {
      break;
    }
  }
  return [str.slice(0, i), str.slice(i)];
}

/**
 * Hard-break a single word that is wider than `width` visible characters.
 * Pushes complete lines into `lines` and returns the leftover fragment.
 */
function breakLongWord(word: string, width: number, lines: string[]): string {
  let remaining = word;
  while (visibleLength(remaining) > width) {
    const [head, tail] = sliceVisible(remaining, width);
    lines.push(head);
    remaining = tail;
  }
  return remaining;
}

export function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (visibleLength(text) <= width) return [text];

  const lines: string[] = [];
  const words = text.split(' ');
  let current = '';

  for (const word of words) {
    const wordVis = visibleLength(word);
    if (current === '') {
      if (wordVis > width) {
        current = breakLongWord(word, width, lines);
      } else {
        current = word;
      }
    } else if (visibleLength(current) + 1 + wordVis > width) {
      lines.push(current);
      if (wordVis > width) {
        current = breakLongWord(word, width, lines);
      } else {
        current = word;
      }
    } else {
      current += ' ' + word;
    }
  }

  if (current !== '') {
    lines.push(current);
  }

  return lines;
}
