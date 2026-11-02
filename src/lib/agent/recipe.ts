import { z } from "zod";

// Recipe logic: read ingredients and method out of the saved text, normalise quantities, scale servings, build a shopping
// list. Everything extracted points at its place in the saved text. Substitutions are Acorn's own ideas, always labelled
// "inferred", and never change the list.

const Span = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() });

export const Ingredient = z.object({
  /** the words as written in the saved item */
  raw: z.string(),
  /** the name without preparation words ("2 cloves garlic, minced" -> "garlic") */
  name: z.string(),
  /** the name in one comparable form (lower case, singular), used only to merge duplicates */
  canonical: z.string(),
  quantity: z.number().positive().nullable(),
  /** the top of a range ("2-3 tbsp"): quantity is the bottom */
  quantityMax: z.number().positive().nullable().default(null),
  unit: z.string().nullable(),
  /** how it is prepared, when the text says ("minced", "finely chopped") */
  prep: z.string().nullable().default(null),
  /** anything else the line says that isn't a quantity, e.g. "400 g" in "1 (400 g) can tomatoes" or "to taste" */
  note: z.string().nullable().default(null),
  source: z.enum(["extracted", "you"]),
  /** where in the saved text it was read from */
  span: Span.nullable().default(null),
});
export type Ingredient = z.infer<typeof Ingredient>;

export const Step = z.object({ text: z.string(), span: Span });

export const ParsedRecipe = z.object({
  title: z.string(),
  ingredients: z.array(Ingredient),
  instructions: z.array(Step),
  /** what the recipe says it serves/makes; null if it doesn't say */
  servings: z.object({ value: z.number().positive(), raw: z.string(), span: Span }).nullable().default(null),
  /** ingredient lines that couldn't be read into a quantity and name; shown, never dropped */
  unreadLines: z.array(z.string()).default([]),
  /** true when no ingredient list was found and the names came from the extraction instead */
  fromEntitiesOnly: z.boolean(),
  /** things that look incomplete (a cropped screenshot, no method, no quantities) */
  warnings: z.array(z.string()).default([]),
});
export type ParsedRecipe = z.infer<typeof ParsedRecipe>;

const UNICODE_FRACTIONS: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
const UNITS: Record<string, string> = {
  g: "g", gram: "g", grams: "g", gm: "g", kg: "kg", kilo: "kg", kilogram: "kg", kilograms: "kg",
  ml: "ml", millilitre: "ml", millilitres: "ml", milliliter: "ml", milliliters: "ml", l: "l", litre: "l", litres: "l", liter: "l", liters: "l",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp", tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  cup: "cup", cups: "cup", oz: "oz", ounce: "oz", ounces: "oz", lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  clove: "clove", cloves: "clove", pinch: "pinch", handful: "handful", can: "can", cans: "can", tin: "can", tins: "can",
  slice: "slice", slices: "slice", stalk: "stalk", stalks: "stalk", sprig: "sprig", sprigs: "sprig", bunch: "bunch", piece: "piece", pieces: "piece",
};
const PREP = new Set(
  "chopped minced diced sliced grated crushed peeled shredded melted softened beaten cubed halved quartered trimmed rinsed drained toasted roasted fresh finely roughly coarsely thinly freshly large small medium ripe fine optional".split(" "),
);
const NOTE_PHRASES = /\b(to taste|as needed|for serving|for garnish|for frying|to serve|optional)\b/i;

/** "1/2" -> 0.5, "1 1/2" -> 1.5, "½" -> 0.5, "2" -> 2. Returns null when it isn't a quantity. */
export function parseQuantity(s: string): number | null {
  let t = s.trim();
  let total = 0;
  for (const [ch, v] of Object.entries(UNICODE_FRACTIONS)) {
    if (t.includes(ch)) {
      total += v;
      t = t.replace(ch, " ").trim();
    }
  }
  if (!t) return total || null;
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (mixed) return Number(mixed[3]) === 0 ? null : Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) return Number(frac[2]) === 0 ? null : total + Number(frac[1]) / Number(frac[2]);
  return /^\d+(\.\d+)?$/.test(t) ? total + Number(t) : null;
}

const singular = (w: string) => (/(?:ss|us)$/.test(w) ? w : w.endsWith("ies") && w.length > 4 ? `${w.slice(0, -3)}y` : /(?:oes|ches|shes|sses)$/.test(w) ? w.slice(0, -2) : w.endsWith("s") && w.length > 3 ? w.slice(0, -1) : w);
export const canonicalName = (name: string) =>
  name
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i, a) => (i === a.length - 1 ? singular(w) : w))
    .join(" ");

const QTY = "(?:\\d+\\s+\\d+\\/\\d+|\\d+(?:\\.\\d+)?(?:\\/\\d+)?|[½¼¾⅓⅔⅛]|\\d+\\s*[½¼¾⅓⅔⅛])";
const LINE = new RegExp(`^(${QTY})(?:\\s*(?:-|–|to)\\s*(${QTY}))?\\s*([a-zA-Z]+)?\\s*(?:of\\s+)?(.*)$`);

/** One ingredient phrase -> quantity (and top of a range), canonical unit, name, preparation and notes. */
export function parseIngredient(raw: string, span: { start: number; end: number } | null = null): Ingredient {
  let text = raw.replace(/\s+/g, " ").replace(/[.;]+$/, "").trim();
  const notes: string[] = [];
  const paren = [...text.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim()).filter(Boolean);
  text = text.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  paren.forEach((p) => notes.push(p));
  const phrase = NOTE_PHRASES.exec(text);
  if (phrase) {
    notes.push(phrase[1].toLowerCase());
    text = text.replace(phrase[0], " ").replace(/\s+/g, " ").trim().replace(/[,\s]+$/, "");
  }
  const comma = text.indexOf(",");
  let prepFromTail: string | null = null;
  if (comma > 0) {
    prepFromTail = text.slice(comma + 1).trim() || null;
    text = text.slice(0, comma).trim();
  }

  const m = LINE.exec(text);
  let quantity: number | null = null;
  let quantityMax: number | null = null;
  let unit: string | null = null;
  let rest = text;
  if (m) {
    const q = parseQuantity(m[1]);
    if (q !== null) {
      quantity = q;
      const hi = m[2] ? parseQuantity(m[2]) : null;
      quantityMax = hi !== null && hi > q ? hi : null;
      const u = m[3] ? UNITS[m[3].toLowerCase()] : undefined;
      unit = u ?? null;
      rest = u ? m[4] : `${m[3] ?? ""} ${m[4]}`.trim();
    }
  }
  const words = rest.split(/\s+/).filter(Boolean);
  const prep = words.filter((w) => PREP.has(w.toLowerCase()));
  const nameWords = words.filter((w) => !PREP.has(w.toLowerCase()));
  const name = (nameWords.join(" ") || rest).toLowerCase().replace(/^of\s+/, "");
  const prepText = [...prep, ...(prepFromTail ? [prepFromTail] : [])].join(", ").toLowerCase() || null;
  return {
    raw: raw.replace(/\s+/g, " ").trim(),
    name,
    canonical: canonicalName(name),
    quantity,
    quantityMax,
    unit,
    prep: prepText,
    note: notes.length ? notes.join("; ") : null,
    source: "extracted",
    span,
  };
}

// ───────────────────────── parsing the saved text ─────────────────────────

const SERVES = /\b(?:serves|servings?|makes|yields?|feeds)\s*:?\s*(\d+)(?:\s*[-–]\s*(\d+))?|\b(\d+)\s+servings?\b/i;

const splitList = (line: string, base: number) => {
  const parts: { text: string; start: number; end: number }[] = [];
  let depth = 0;
  let from = 0;
  const push = (to: number) => {
    const slice = line.slice(from, to);
    const lead = slice.length - slice.trimStart().length;
    const t = slice.trim();
    if (t) parts.push({ text: t, start: base + from + lead, end: base + from + lead + t.length });
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if ((c === "," || c === ";") && depth === 0) {
      // a comma followed by a preparation word belongs to the same ingredient ("garlic, minced")
      const next = /^\s*(\w+)/.exec(line.slice(i + 1))?.[1]?.toLowerCase();
      if (next && PREP.has(next) && !/^\s*\d/.test(line.slice(i + 1))) continue;
      push(i);
      from = i + 1;
    }
  }
  push(line.length);
  return parts;
};

const sentences = (line: string, base: number) => {
  const out: { text: string; span: { start: number; end: number } }[] = [];
  const re = /[^.!?]+[.!?]?/g;
  for (const m of line.matchAll(re)) {
    const lead = m[0].length - m[0].trimStart().length;
    const t = m[0].trim();
    if (t.length > 1) out.push({ text: t, span: { start: base + m.index + lead, end: base + m.index + lead + t.length } });
  }
  return out;
};

function looksLikeIngredientLine(line: string) {
  const parts = splitList(line, 0);
  return parts.length >= 3 && parts.filter((p) => /^(?:\d|[½¼¾⅓⅔⅛])/.test(p.text)).length >= Math.ceil(parts.length / 2);
}

export function parseRecipe(input: { title: string; text: string; entities: { name: string; kind: string }[] }): ParsedRecipe {
  const ingredients: Ingredient[] = [];
  const instructions: { text: string; span: { start: number; end: number } }[] = [];
  const unreadLines: string[] = [];
  let section: "none" | "ingredients" | "method" = "none";
  let servings: ParsedRecipe["servings"] = null;

  const sv = SERVES.exec(input.text);
  if (sv) {
    const value = Number(sv[1] ?? sv[3]);
    if (value > 0 && value <= 200) servings = { value, raw: sv[0], span: { start: sv.index, end: sv.index + sv[0].length } };
  }

  const addIngredients = (line: string, base: number) => {
    for (const p of splitList(line, base)) {
      const ing = parseIngredient(p.text, { start: p.start, end: p.end });
      if (ing.name.length < 2 || /^[\d\s./-]+$/.test(ing.name)) unreadLines.push(p.text);
      else ingredients.push(ing);
    }
  };

  let pos = 0;
  for (const rawLine of input.text.split("\n")) {
    const lead = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const base = pos + lead;
    pos += rawLine.length + 1;
    if (!line) continue;
    const head = /^(ingredients?|method|instructions?|directions?|steps?|preparation)\s*:?\s*(.*)$/i.exec(line);
    if (head) {
      section = /^ingredient/i.test(head[1]) ? "ingredients" : "method";
      const off = base + line.length - head[2].length;
      if (head[2] && section === "ingredients") addIngredients(head[2], off);
      else if (head[2]) instructions.push(...sentences(head[2], off));
      continue;
    }
    if (section === "ingredients") addIngredients(line.replace(/^[-•*·]\s*/, ""), base + (line.length - line.replace(/^[-•*·]\s*/, "").length));
    else if (section === "method") instructions.push(...sentences(line.replace(/^(?:\d+[.)]\s+|step\s*\d+\s*:?\s*)/i, ""), base + (line.length - line.replace(/^(?:\d+[.)]\s+|step\s*\d+\s*:?\s*)/i, "").length)));
    else if (!/^\d+[.)]\s/.test(line) && looksLikeIngredientLine(line)) addIngredients(line, base);
    else if (/^(?:\d+[.)]\s+|step\s*\d+)/i.test(line)) {
      const body = line.replace(/^(?:\d+[.)]\s+|step\s*\d+\s*:?\s*)/i, "");
      instructions.push(...sentences(body, base + (line.length - body.length)));
    }
  }

  const warnings: string[] = [];
  let fromEntitiesOnly = false;
  let list = ingredients;
  if (list.length === 0) {
    fromEntitiesOnly = true;
    list = input.entities
      .filter((e) => e.kind === "ingredient")
      .map((e) => ({ raw: e.name, name: e.name.toLowerCase(), canonical: canonicalName(e.name), quantity: null, quantityMax: null, unit: null, prep: null, note: null, source: "extracted" as const, span: null }));
    if (list.length) warnings.push("No ingredient list was found in the saved text. These names come from what Acorn recognised, without quantities.");
  } else {
    if (list.every((i) => i.quantity === null)) warnings.push("None of the ingredients has a quantity in the saved text.");
    if (instructions.length === 0) warnings.push("No method was found. The saved item may be cropped or incomplete.");
    if (unreadLines.length) warnings.push(`${unreadLines.length} ingredient line(s) couldn't be read and are listed separately.`);
  }
  return { title: input.title, ingredients: list, instructions, servings, unreadLines, fromEntitiesOnly, warnings };
}

// ───────────────────────── shopping list ─────────────────────────

export const ShoppingItem = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  quantity: z.number().positive().nullable(),
  quantityMax: z.number().positive().nullable().default(null),
  /** the quantity as extracted, before any servings change (so changing servings twice never compounds) */
  baseQuantity: z.number().positive().nullable().default(null),
  unit: z.string().nullable(),
  prep: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
  /** extracted: the saved recipe lists it. you: added or changed by the user. */
  source: z.enum(["extracted", "you"]),
  checked: z.boolean(),
});
export type ShoppingItem = z.infer<typeof ShoppingItem>;

export const Substitution = z.object({
  for: z.string(),
  idea: z.string(),
  /** always "inferred": Acorn's own suggestion, not something the recipe says */
  source: z.literal("inferred"),
});
export type Substitution = z.infer<typeof Substitution>;

const SUBSTITUTIONS: Record<string, string> = {
  parmesan: "pecorino romano (similar hard, salty cheese)",
  butter: "olive oil (changes flavour slightly)",
  "heavy cream": "full-fat coconut milk (changes flavour)",
  "pasta water": "plain hot water with a pinch of salt (less starchy, so less glossy)",
  spaghetti: "linguine or any long pasta",
  lemon: "lime (milder acidity differs)",
  cilantro: "parsley (different flavour)",
  coriander: "parsley (different flavour)",
};

const round = (n: number) => Math.round(n * 100) / 100;

/** Merge duplicates (same canonical name and unit). Different units are NOT converted: that would be a guess. */
export function buildShoppingList(recipe: ParsedRecipe, targetServings: number | null = null): { items: ShoppingItem[]; substitutions: Substitution[]; servings: { original: number | null; target: number | null }; warnings: string[] } {
  const original = recipe.servings?.value ?? null;
  const factor = targetServings !== null && original ? targetServings / original : 1;
  const merged = new Map<string, ShoppingItem>();
  for (const ing of recipe.ingredients) {
    const key = `${ing.canonical}\u0000${ing.unit ?? ""}`;
    const prev = merged.get(key);
    if (prev) {
      if (prev.baseQuantity !== null && ing.quantity !== null) prev.baseQuantity = round(prev.baseQuantity + ing.quantity);
      else if (ing.quantity !== null) prev.baseQuantity = ing.quantity;
      if (ing.quantityMax !== null && prev.quantityMax !== null) prev.quantityMax = round(prev.quantityMax + ing.quantityMax);
      continue;
    }
    merged.set(key, { id: `i${merged.size + 1}`, name: ing.name, quantity: ing.quantity, quantityMax: ing.quantityMax, baseQuantity: ing.quantity, unit: ing.unit, prep: ing.prep, note: ing.note, source: "extracted", checked: false });
  }
  const items = [...merged.values()].map((i) => ({ ...i, quantity: i.baseQuantity === null ? null : round(i.baseQuantity * factor), quantityMax: i.quantityMax === null ? null : round(i.quantityMax * factor) }));
  const substitutions = items.flatMap((i) => {
    const idea = Object.entries(SUBSTITUTIONS).find(([k]) => i.name === k || i.name.endsWith(` ${k}`));
    return idea ? [{ for: i.name, idea: idea[1], source: "inferred" as const }] : [];
  });
  return { items, substitutions, servings: { original, target: targetServings }, warnings: recipe.warnings };
}

/** Recompute item quantities for a new serving count from the extracted base amounts. Items you changed keep your numbers. */
export function rescale(items: ShoppingItem[], original: number, target: number): ShoppingItem[] {
  const f = target / original;
  return items.map((i) => (i.source === "extracted" && i.baseQuantity !== null ? { ...i, quantity: round(i.baseQuantity * f), quantityMax: i.quantityMax === null ? null : round(i.quantityMax * f) } : i));
}

export const formatQuantity = (i: { quantity: number | null; quantityMax?: number | null; unit: string | null }) => {
  if (i.quantity === null) return "";
  const n = (x: number) => (Number.isInteger(x) ? String(x) : String(round(x)));
  return `${n(i.quantity)}${i.quantityMax ? `–${n(i.quantityMax)}` : ""}${i.unit ? ` ${i.unit}` : ""}`;
};
