/**
 * People type unit names the way they say them — plural, abbreviated, without
 * the faction prefix. Oracle matches its own datasheet titles. This produces
 * the small set of spellings worth trying before declaring a name unresolved.
 *
 * Order matters: the user's own words are tried first so an exact datasheet
 * name is never second-guessed.
 */

const PREFIXES = [
  "chaos ",
  "death guard ",
  "space marine ",
  "adeptus ",
  "imperial ",
];

function singular(name: string): string | null {
  const t = name.trim();
  if (/\bies$/i.test(t)) return t.replace(/ies$/i, "y");
  // "Terminators" -> "Terminator", but never "Chaos" -> "Chao".
  if (/[^s]s$/i.test(t)) return t.slice(0, -1);
  return null;
}

export function nameVariants(raw: string): string[] {
  const name = raw.trim().replace(/\s+/g, " ");
  const out: string[] = [name];

  const push = (v: string | null | undefined): void => {
    const t = v?.trim();
    if (t && t.length > 2 && !out.some((x) => x.toLowerCase() === t.toLowerCase())) {
      out.push(t);
    }
  };

  push(singular(name));

  // Last word pluralised is the common case: "Deathshroud Terminators".
  const words = name.split(" ");
  if (words.length > 1) {
    const last = words[words.length - 1]!;
    const lastSingular = singular(last);
    if (lastSingular) push([...words.slice(0, -1), lastSingular].join(" "));
    // "Chaos Rhino" when the user typed "Rhino".
    push(words.slice(1).join(" "));
  }

  // A bare name may need its faction prefix restored.
  for (const p of PREFIXES) {
    if (!name.toLowerCase().startsWith(p)) push(`${p}${name}`);
  }

  return out;
}
