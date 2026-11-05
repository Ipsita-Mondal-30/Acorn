import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CvFileError, extractCvText, extractDocx, extractPdf, isDocx, MAX_CV_BYTES, sniffCv } from "@/lib/cv/extract";
import { checkSpans, parseCv, parseRange, rangeMonths } from "@/lib/cv/parse";
import { docx, pdf, pdfWithToUnicode, scannedPdf, zip } from "./helpers/office";

const fx = (n: string) => new Uint8Array(readFileSync(path.resolve(__dirname, "fixtures", n)));
const SAMPLE_TXT = readFileSync(path.resolve(__dirname, "fixtures/cv-sample.txt"), "utf8").trim();
const bytes = (b: Buffer) => new Uint8Array(b);
const NOW = new Date("2026-11-01T00:00:00Z");

describe("file sniffing (by bytes, never by name)", () => {
  it("recognises PDF, DOCX and plain text, and nothing else", () => {
    expect(sniffCv(fx("cv-sample.pdf"))).toBe("pdf");
    expect(sniffCv(fx("cv-sample.docx"))).toBe("docx");
    expect(sniffCv(fx("cv-sample.txt"))).toBe("txt");
    expect(sniffCv(new Uint8Array())).toBeNull();
    expect(sniffCv(bytes(zip({ "hello.txt": "hi" })))).toBeNull(); // some other zip
    expect(sniffCv(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 1, 2]))).toBeNull(); // legacy .doc
    expect(sniffCv(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]))).toBeNull(); // an executable
    expect(sniffCv(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull(); // a PNG
    expect(isDocx(bytes(docx(["x"])))).toBe(true);
  });
});

describe("text extraction", () => {
  it("reads real files made by other tools: a Quartz PDF, a Word-style DOCX and a text file give the same text", () => {
    const [pdfT, docxT, txtT] = ["cv-sample.pdf", "cv-sample.docx", "cv-sample.txt"].map((n) => extractCvText(fx(n)));
    expect([pdfT.kind, docxT.kind, txtT.kind]).toEqual(["pdf", "docx", "txt"]);
    for (const t of [pdfT, docxT, txtT]) {
      expect(t.readable).toBe(true);
      expect(t.text).toBe(SAMPLE_TXT);
    }
  });

  it("reads a Flate-compressed PDF with escapes, and a PDF whose text only a ToUnicode map can decode", () => {
    const lines = ["Priya Nair (Backend Engineer)", "Built APIs: 99.9% uptime", "Led a team of 4 engineers"];
    expect(extractPdf(bytes(pdf(lines))).trim().split("\n")).toEqual(lines);
    expect(extractPdf(bytes(pdf(lines, { compress: false }))).trim().split("\n")).toEqual(lines);
    expect(extractPdf(bytes(pdfWithToUnicode(lines))).trim().split("\n")).toEqual(lines);
  });

  it("reads DOCX paragraphs, list items and XML entities", () => {
    const t = extractDocx(bytes(docx(["Asha & Co <Ltd>", "Experience", "- Built things", "Plain paragraph"])));
    expect(t.split("\n")).toEqual(["Asha & Co <Ltd>", "Experience", "- Built things", "Plain paragraph"]);
  });

  it("refuses what it cannot honestly read: scans, password-protected PDFs, damaged DOCX, other types, too-large files", () => {
    const scan = extractCvText(bytes(scannedPdf()));
    expect(scan.readable).toBe(false);
    expect(scan.warning).toMatch(/little or no readable text/);
    expect(() => extractCvText(bytes(pdf(["secret"], { encrypt: true })))).toThrow(/password-protected/);
    const broken = Buffer.from(docx(["Hello"]));
    broken.fill(0, broken.length - 30, broken.length - 22); // damage the end-of-directory record's signature area
    expect(() => extractCvText(new Uint8Array(broken))).toThrow(CvFileError);
    expect(() => extractCvText(new Uint8Array([0x4d, 0x5a, 0x90, 0]))).toThrow(/PDF, a Word document/);
    expect(() => extractCvText(new Uint8Array(MAX_CV_BYTES + 1).fill(65))).toThrow(/5 MB/);
  });

  it("is not fooled by lookalikes: a zip with no document.xml, and binary pretending to be text", () => {
    expect(() => extractCvText(bytes(zip({ "word/other.xml": "<x/>" })))).toThrow(CvFileError);
    expect(() => extractCvText(new Uint8Array([0x41, 0x42, 0, 0x43, 0xff, 0xfe]))).toThrow(CvFileError);
  });
});

describe("structured parsing with evidence spans", () => {
  const cv = parseCv(SAMPLE_TXT, NOW);

  it("extracts name, contact, roles with dates, projects, skills, education and certifications", () => {
    expect(cv.name?.text).toBe("Asha Rao");
    expect(cv.contact.emails.map((e) => e.text)).toEqual(["asha.rao@example.com"]);
    expect(cv.contact.phones.map((e) => e.text)).toEqual(["+91 98765 43210"]);
    expect(cv.contact.links.map((e) => e.text)).toEqual(["linkedin.com/in/asharao"]);
    expect(cv.summary?.text).toMatch(/growth experiments/);
    expect(cv.experience.map((e) => [e.title, e.org, e.dates?.raw, e.bullets.length])).toEqual([
      ["Senior Frontend Engineer", "Brightly Labs", "Jan 2021 - Present", 2],
      ["Frontend Engineer", "Kiln Studio", "Jun 2018 - Dec 2020", 1],
    ]);
    expect(cv.projects).toHaveLength(1);
    expect(cv.skills.map((s) => s.text)).toEqual(["React", "TypeScript", "Next.js", "Node.js", "SQL", "A/B testing"]);
    expect(cv.education[0]).toMatchObject({ text: "B.Tech Computer Science, NIT Trichy, 2014 - 2018" });
    expect(cv.education[0].dates?.raw).toBe("2014 - 2018");
    expect(cv.certifications[0]).toMatchObject({ year: 2022 });
    expect(cv.warnings).toEqual([]);
  });

  it("every extracted item points at its own words in the original text", () => {
    expect(checkSpans(SAMPLE_TXT, cv)).toEqual([]);
    for (const e of cv.experience) for (const b of e.bullets) expect(SAMPLE_TXT.slice(b.span.start, b.span.end)).toBe(b.text);
    // and a parse of a different text does not validate against this one
    expect(checkSpans("short", cv).length).toBeGreaterThan(0);
  });

  it("parses date ranges, 'Present', and says how sure the length is", () => {
    expect(parseRange("Jan 2021 - Present", 0)).toMatchObject({ start: "2021-01", end: null, precision: "month" });
    expect(parseRange("03/2019 – 11/2020", 0)).toMatchObject({ start: "2019-03", end: "2020-11" });
    expect(parseRange("2019 - 2021", 0)).toMatchObject({ precision: "year" });
    expect(parseRange("Brightly Labs", 0)).toBeNull();
    const month = parseRange("Jan 2021 - Dec 2021", 0)!;
    expect(rangeMonths(month, NOW)).toEqual({ min: 12, max: 12 });
    expect(rangeMonths(parseRange("Jan 2021 - Present", 0)!, NOW).min).toBe(71); // Jan 2021 .. Nov 2026, both months counted
  });

  it("year-only dates give a range, not a false precision", () => {
    const r = rangeMonths(parseRange("2019 - 2021", 0)!, NOW);
    expect(r.min).toBeLessThan(r.max);
    expect(r.min).toBeLessThanOrEqual(24);
    expect(r.max).toBeGreaterThanOrEqual(24);
  });

  it("flags contradictory dates instead of fixing them", () => {
    const bad = parseCv("Jo Lee\n\nExperience\nEngineer, Acme\nJan 2022 - Mar 2021\n- Did things\n\nEngineer, Beta\nJun 2020 - Dec 2022\n- Did other things\n\nEngineer, Gamma\nMay 2021 - Present\n- More", NOW);
    const codes = bad.warnings.map((w) => w.code);
    expect(codes).toContain("end_before_start");
    expect(codes).toContain("overlap");
    expect(bad.experience[0].dates).toMatchObject({ start: "2022-01", end: "2021-03" }); // kept as written
  });

  it("says when there are no dates or no sections, and invents neither", () => {
    const flat = parseCv("Jo Lee\nI build web apps with React and have done so for years.", NOW);
    expect(flat.warnings.map((w) => w.code)).toContain("no_sections");
    expect(flat.experience).toEqual([]);
    const undated = parseCv("Jo Lee\n\nExperience\nEngineer, Acme\n- Built React apps", NOW);
    expect(undated.warnings.map((w) => w.code)).toContain("no_dates");
    expect(undated.experience[0].dates).toBeNull();
  });

  it("copes with an empty or heading-only text without throwing", () => {
    expect(() => parseCv("", NOW)).not.toThrow();
    expect(parseCv("Experience\n", NOW).experience).toEqual([]);
  });
});
