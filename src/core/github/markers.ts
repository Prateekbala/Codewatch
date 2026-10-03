const startMarker = (id: string): string => `<!-- pr-agent:${id}:start -->`;
const endMarker = (id: string): string => `<!-- pr-agent:${id}:end -->`;

const sectionPattern = (id: string): RegExp => {
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\n*${escape(startMarker(id))}[\\s\\S]*?${escape(endMarker(id))}\\n*`, "g");
};

export const wrapManagedSection = (id: string, content: string): string =>
  `${startMarker(id)}\n${content.trim()}\n${endMarker(id)}`;

export const hasManagedSection = (body: string, id: string): boolean =>
  body.includes(startMarker(id)) && body.includes(endMarker(id));

export const stripManagedSection = (body: string, id: string): string =>
  body.replace(sectionPattern(id), "\n\n").trim();

export const upsertManagedSection = (body: string, id: string, content: string): string => {
  const section = wrapManagedSection(id, content);
  if (hasManagedSection(body, id)) {
    const pattern = sectionPattern(id);
    let replaced = false;
    return body
      .replace(pattern, () => {
        if (replaced) {
          return "";
        }
        replaced = true;
        return `\n\n${section}\n\n`;
      })
      .trim();
  }
  const base = body.trim();
  return base === "" ? section : `${base}\n\n${section}`;
};

const FINDING_MARKER = /<!-- pr-agent:finding:([0-9a-f]{16}) -->/g;

export const findingMarker = (id: string): string => `<!-- pr-agent:finding:${id} -->`;

export const extractFindingIds = (body: string): string[] =>
  [...body.matchAll(FINDING_MARKER)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
