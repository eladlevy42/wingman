// Proprietary synonym and stemming tables are omitted in the public showcase version.
// Placeholder: lowercase, trim, and collapse inner whitespace. Nothing else.

export function normalizeTerm(term: string): string {
  return term.toLowerCase().trim().replace(/\s+/g, " ");
}

export function canonicalizeTerm(term: string): string {
  return normalizeTerm(term);
}
