// DEMO MODE ONLY. SAM 3.1 is a paid model Acorn calls in Meta mode. In demo mode there is nothing to run, so for Acorn's
// own fictional sample screenshots (whose layout and text are known) these hand-measured boxes stand in, and every
// result built from them says so. Boxes are xyxy source pixels of the 900x600 sample image.
export type FixtureRegion = { keywords: string[]; box: { x1: number; y1: number; x2: number; y2: number }; text: string };
export const SAM_FIXTURES: Record<string, { frame: { w: number; h: number }; regions: FixtureRegion[] }> = {
  "job-listing": {
    frame: { w: 900, h: 600 },
    regions: [
      { keywords: ["title", "company", "role", "northwind", "job", "heading"], box: { x1: 36, y1: 100, x2: 622, y2: 140 }, text: "Northwind Labs — Senior Data Engineer" },
      { keywords: ["location", "remote", "lisbon", "place"], box: { x1: 36, y1: 148, x2: 408, y2: 182 }, text: "Location: Remote (EU) or Lisbon" },
      { keywords: ["about", "description", "pipelines", "analytics"], box: { x1: 36, y1: 193, x2: 840, y2: 228 }, text: "About the role: Build the pipelines behind our logistics analytics product." },
      { keywords: ["requirements", "requirement", "python", "sql", "postgresql", "kafka", "skills", "list"], box: { x1: 36, y1: 238, x2: 636, y2: 448 }, text: "Requirements: 5+ years of experience with Python and SQL; Strong PostgreSQL skills: indexing and query tuning; Experience with Kafka or another streaming system; Nice to have: dbt or Airflow" },
      { keywords: ["deadline", "close", "closing", "date", "applications"], box: { x1: 36, y1: 458, x2: 446, y2: 492 }, text: "Applications close 15 January 2027." },
      { keywords: ["apply", "url", "link", "website"], box: { x1: 36, y1: 502, x2: 694, y2: 538 }, text: "Apply at https://jobs.example.com/northwind/data-engineer" },
    ],
  },
};
