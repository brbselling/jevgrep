import { renderResult } from "../apps/cli/src/render";
import { routeProviderFetch } from "./fixtures/provider-route.mjs";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testIfDocker } from "./helpers/docker";
import { retrieve } from "../packages/core/src/retrieve";
import { resolveMaxQuestions } from "../packages/core/src/selection";
import { createEvaluator, EvaluationFailure } from "../packages/core/src/evaluator";
import type { EvaluationRequest } from "../packages/core/src/evaluator";
import type { SearchInput } from "../packages/core/src/types";

testIfDocker(
  "hierarchical retrieval returns source from multiple files without uploading excluded data",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jg-tree-"));
    const sent: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          state: { items?: Array<{ path: string }> };
          questions: Record<string, unknown>;
        };
        sent.push(JSON.stringify(body));
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.9 }]),
          ),
        });
      },
    });
    try {
      await mkdir(join(root, "src/deep"), { recursive: true });
      await writeFile(join(root, ".gitignore"), "skipped.ts\n");
      await writeFile(join(root, "skipped.ts"), "DO_NOT_UPLOAD_IGNORED");
      await writeFile(join(root, ".env"), "DO_NOT_UPLOAD_SECRET");
      await writeFile(
        join(root, "src/events.ts"),
        "export class Events { record(name:string) {return name;} }\n",
      );
      await writeFile(
        join(root, "src/deep/backend.ts"),
        "export function sendEvent(name:string) {return name;}\n",
      );
      await writeFile(join(root, "test.ts"), "export function testEvent() {return true;}\n");
      const signal = new AbortController().signal;
      const evaluator = createEvaluator({
        apiKey: "fixture",
        provider: "vercel",
        fetch: routeProviderFetch(fetch, `http://127.0.0.1:${server.port}`),
        signal,
      });
      const result = await retrieve({ root, query: "research event recording", signal }, evaluator);
      expect(result.status).toBe("complete");
      expect(result.files.map((file) => file.path).sort()).toEqual([
        "src/deep/backend.ts",
        "src/events.ts",
        "test.ts",
      ]);
      expect(
        result.files
          .find((file) => file.path === "src/events.ts")
          ?.excerpts.some((excerpt) => excerpt.source.includes("record(name:string)")),
      ).toBe(true);
      expect(sent.join("\n")).not.toContain("DO_NOT_UPLOAD");
      expect(result.counts.requests).toBe(sent.length);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

testIfDocker(
  "excluded paths are never uploaded or returned",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jg-exclude-"));
    const sent: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { questions: Record<string, unknown> };
        sent.push(JSON.stringify(body));
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.9 }]),
          ),
        });
      },
    });
    try {
      await mkdir(join(root, "src/generated"), { recursive: true });
      await writeFile(
        join(root, "src/events.ts"),
        "export class Events { record(name:string) {return name;} }\n",
      );
      await writeFile(
        join(root, "src/events.test.ts"),
        'export const excludedTest = "DO_NOT_UPLOAD_TEST";\n',
      );
      await writeFile(
        join(root, "src/generated/client.ts"),
        'export const excludedClient = "DO_NOT_UPLOAD_GENERATED";\n',
      );
      const signal = new AbortController().signal;
      const evaluator = createEvaluator({
        apiKey: "fixture",
        provider: "vercel",
        fetch: routeProviderFetch(fetch, `http://127.0.0.1:${server.port}`),
        signal,
      });
      const result = await retrieve(
        {
          root,
          query: "research event recording",
          policy: { exclude: ["*.test.ts", "src/generated/"] },
          signal,
        },
        evaluator,
      );
      expect(result.status).toBe("complete");
      expect(result.files.map((file) => file.path)).toEqual(["src/events.ts"]);
      expect(sent.join("\n")).not.toContain("DO_NOT_UPLOAD");
      expect(sent.join("\n")).not.toContain("generated");
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

testIfDocker(
  "newly ignored evidence is withheld from follow-up requests and returned excerpts",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jg-ignore-change-"));
    const followups: Array<{ path?: string; selectedEvidence?: Array<{ path: string }> }> = [];
    let sawFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      sawFirst = resolve;
    });
    let calls = 0;
    try {
      await writeFile(
        join(root, "a.ts"),
        'export function firstEvent() {return "WITHHOLD_AFTER_IGNORE";}\n',
      );
      await writeFile(join(root, "b.ts"), "export function secondEvent() {return true;}\n");
      const result = await retrieve(
        { root, query: "event behavior", signal: new AbortController().signal },
        {
          get requests() {
            return calls;
          },
          async evaluate(request) {
            calls++;
            const state = request.state as {
              path?: string;
              declarations?: unknown;
              selectedEvidence?: Array<{ path: string }>;
            };
            if (state.declarations && !state.selectedEvidence) {
              if (state.path === "a.ts") sawFirst();
              if (state.path === "b.ts") {
                await first;
                await writeFile(join(root, ".ignore"), "a.ts\n");
              }
            }
            if (state.selectedEvidence) followups.push(state);
            return Object.fromEntries(
              Object.keys(request.questions).map((id) => [id, /^q\d+$/.test(id) ? 0.8 : 0.9]),
            );
          },
        },
      );
      expect(followups.length).toBeGreaterThan(0);
      expect(
        followups.some((request) => request.selectedEvidence?.some((file) => file.path === "a.ts")),
      ).toBe(false);
      expect(result.status).toBe("incomplete");
      expect(result.files.find((file) => file.path === "a.ts")?.excerpts).toEqual([]);
      expect(result.files.find((file) => file.path === "a.ts")?.sourceOmitted).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

testIfDocker(
  "admitted text replaced with binary is incomplete rather than a healthy empty excerpt",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jg-binary-change-"));
    let calls = 0;
    try {
      await writeFile(join(root, "event.ts"), "export function event() {return true;}\n");
      const result = await retrieve(
        { root, query: "event behavior", signal: new AbortController().signal },
        {
          get requests() {
            return calls;
          },
          async evaluate(request) {
            calls++;
            const state = request.state as { items?: unknown[] };
            if (state.items) await writeFile(join(root, "event.ts"), Buffer.from([0, 1, 2]));
            return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.9]));
          },
        },
      );
      expect(result.status).toBe("incomplete");
      expect(result.issues.some((issue) => issue.kind === "changed")).toBe(true);
      expect(result.files[0]?.path).toBe("event.ts");
      expect(result.files[0]?.excerpts).toEqual([]);
      expect(result.files[0]?.sourceOmitted).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

testIfDocker(
  "donors ignored during follow-up are absent from later evaluation requests",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jg-followup-change-"));
    let calls = 0;
    let changed = false;
    let staleUploads = 0;
    let followups = 0;
    try {
      for (let index = 0; index < 12; index++) {
        await writeFile(
          join(root, `${index}.ts`),
          `export function record${index}() {return true;}\n`,
        );
      }
      const result = await retrieve(
        { root, query: "record behavior", signal: new AbortController().signal },
        {
          get requests() {
            return calls;
          },
          async evaluate(request, policy) {
            await policy?.beforeAttempt?.();
            calls++;
            const state = request.state as { selectedEvidence?: Array<{ path: string }> };
            if (state.selectedEvidence) {
              followups++;
              if (followups > 1 && state.selectedEvidence.some((entry) => entry.path === "0.ts"))
                staleUploads++;
              if (!changed) {
                changed = true;
                await writeFile(join(root, ".ignore"), "0.ts\n");
              }
            }
            return Object.fromEntries(
              Object.keys(request.questions).map((id) => [id, /^q\d+$/.test(id) ? 0.8 : 0.9]),
            );
          },
        },
      );
      expect(changed).toBe(true);
      expect(followups).toBeGreaterThan(1);
      expect(staleUploads).toBe(0);
      expect(result.status).toBe("incomplete");
      expect(result.files.find((file) => file.path === "0.ts")?.excerpts).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

testIfDocker("an aborted evaluator cannot return a previously cached answer", async () => {
  const { createEvaluationCache } = await import("../packages/core/src/cache");
  const directory = await mkdtemp(join(tmpdir(), "jg-cache-abort-"));
  const controller = new AbortController();
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls++;
      return Response.json({ answers: { q: { type: "noul", noul: 0.8 } } });
    },
  });
  try {
    const evaluator = createEvaluator({
      apiKey: "fixture",
      provider: "vercel",
      fetch: routeProviderFetch(fetch, `http://127.0.0.1:${server.port}`),
      signal: controller.signal,
      cache: createEvaluationCache({ directory }),
    });
    const request = {
      state: "test",
      questions: { q: { type: "boolean" as const, instructions: "Relevant?" } },
    };
    expect(await evaluator.evaluate(request)).toEqual({ q: 0.8 });
    expect(await evaluator.evaluate(request)).toEqual({ q: 0.8 });
    expect(evaluator.cacheHits).toBe(1);
    controller.abort();
    await expect(evaluator.evaluate(request)).rejects.toMatchObject({ kind: "cancelled" });
    expect(calls).toBe(1);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

testIfDocker(
  "a file excluded during declaration selection is not uploaded in later groups",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jg-group-change-"));
    let declarations = 0;
    try {
      await writeFile(
        join(root, "events.ts"),
        Array.from({ length: 400 }, (_, i) => `export function event${i}() {return true;}\n`).join(
          "",
        ),
      );
      const result = await retrieve(
        { root, query: "event behavior", signal: new AbortController().signal },
        {
          requests: 0,
          async evaluate(request) {
            const state = request.state as { declarations?: unknown[] };
            if (state.declarations) {
              declarations++;
              if (declarations === 1) await writeFile(join(root, ".ignore"), "events.ts\n");
            }
            return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.9]));
          },
        },
      );
      expect(declarations).toBe(1);
      expect(result.status).toBe("incomplete");
      expect(result.files[0]?.excerpts).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

testIfDocker(
  "cancellation between declaration groups preserves already selected source",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jg-partial-cancel-"));
    const controller = new AbortController();
    let groups = 0;
    try {
      await writeFile(
        join(root, "events.ts"),
        Array.from({ length: 400 }, (_, i) => `export function event${i}() {return ${i};}\n`).join(
          "",
        ),
      );
      const result = await retrieve(
        { root, query: "event behavior", signal: controller.signal },
        {
          requests: 0,
          async evaluate(request) {
            if ((request.state as { declarations?: unknown[] }).declarations) {
              groups++;
              controller.abort();
            }
            return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.9]));
          },
        },
      );
      expect(result.status).toBe("interrupted");
      expect(groups).toBe(1);
      const source = result.files
        .flatMap((file) => file.excerpts.map((excerpt) => excerpt.source))
        .join("\n");
      expect(source).toContain("function event0");
      expect(source).not.toContain("function event399");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

testIfDocker(
  "file priority reaches stdout without changing relevance or excluding background documents",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jg-priority-"));
    const roles: Array<{ query: string; path: string; preview: { text: string } }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          state: {
            query: string;
            path: string;
            preview?: { text: string };
            items?: Array<{ path: string }>;
          };
          questions: Record<string, unknown>;
        };
        if (body.state.preview) roles.push(body.state as (typeof roles)[number]);
        const design = body.state.query.includes("design");
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id, index) => [
              id,
              {
                type: "noul",
                noul:
                  id === "priority"
                    ? body.state.path.startsWith("specs/") === design
                      ? 0.95
                      : 0.1
                    : body.state.items
                      ? body.state.items[index]!.path.startsWith("specs/")
                        ? 0.99
                        : 0.7
                      : 0.9,
              },
            ]),
          ),
        });
      },
    });
    try {
      await mkdir(join(root, "src"));
      await mkdir(join(root, "specs"));
      await writeFile(
        join(root, "src/events.ts"),
        "export function record(name: string) { return name; }",
      );
      await writeFile(
        join(root, "specs/events.md"),
        "# Event design\nA plan for recording event names.",
      );
      for (const query of [
        "How does event recording work?",
        "Explain the event recording design plan",
      ]) {
        const signal = new AbortController().signal;
        const evaluator = createEvaluator({
          provider: "vercel",
          apiKey: "fixture",
          signal,
          fetch: routeProviderFetch(fetch, `http://127.0.0.1:${server.port}`),
        });
        const value = await retrieve({ root, query, signal }, evaluator);
        expect(value.status).toBe("complete");
        expect(value.files.find((file) => file.path === "specs/events.md")!.score).toBe(0.99);
        const output = renderResult(value);
        const expected = query.includes("design")
          ? ["specs/events.md", "src/events.ts"]
          : ["src/events.ts", "specs/events.md"];
        expect(output.indexOf(`- "${expected[0]}"`)).toBeLessThan(
          output.indexOf(`- "${expected[1]}"`),
        );
        expect(output.indexOf(`Source block "${expected[0]}"`)).toBeLessThan(
          output.indexOf(`Source block "${expected[1]}"`),
        );
        expect(value.files.every((file) => !file.roles.includes("priority"))).toBe(true);
      }
      expect(
        roles.some(
          (state) => state.path === "specs/events.md" && state.preview.text.includes("A plan"),
        ),
      ).toBe(true);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

testIfDocker(
  "test-body provider failure retains evidence and its diagnostic",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jg-test-body-failure-"));
    try {
      await writeFile(
        join(root, "test_behavior.py"),
        "import pytest\ndef test_behavior():\n    assert True\n",
      );
      const result = await retrieve(
        { root, query: "behavior tests", signal: new AbortController().signal },
        {
          requests: 0,
          async evaluate(request) {
            if (Object.hasOwn(request.state as object, "candidates"))
              throw new EvaluationFailure(
                "provider",
                false,
                undefined,
                "HTTP 503: fixture test selection unavailable",
              );
            return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.95]));
          },
        },
      );
      expect(result.status).toBe("incomplete");
      expect(result.files[0]?.path).toBe("test_behavior.py");
      const output = renderResult(result);
      expect(output).toContain("def test_behavior():");
      expect(output).toContain("HTTP 503: fixture test selection unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

testIfDocker(
  "terminal refinement failures stop later files without discarding first-pass evidence",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jg-refinement-stop-"));
    try {
      for (const path of ["a.ts", "b.ts", "c.ts"])
        await writeFile(join(root, path), "export function event() { return true; }\n");
      let followups = 0;
      const result = await retrieve(
        { root, query: "event", signal: new AbortController().signal },
        {
          requests: 0,
          async evaluate(request) {
            if ((request.state as { selectedEvidence?: unknown }).selectedEvidence) {
              followups++;
              throw new EvaluationFailure("authentication");
            }
            return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.8]));
          },
        },
      );
      expect(followups).toBe(1);
      expect(result.status).toBe("incomplete");
      expect(result.files).toHaveLength(3);
      expect(result.files.every((file) => file.selected.length > 0)).toBe(true);
      expect(result.issues).toContainEqual({ kind: "authentication", count: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("the question batch size prefers an explicit limit, then JEVGREP_MAX_QUESTIONS, then 128", () => {
  expect(resolveMaxQuestions(4, "2")).toBe(4);
  expect(resolveMaxQuestions(undefined, "2")).toBe(2);
  expect(resolveMaxQuestions(undefined, " 16 ")).toBe(16);
  expect(resolveMaxQuestions(undefined, undefined)).toBe(128);
  for (const raw of ["0", "nope", "", "1.5", "-3"])
    expect(resolveMaxQuestions(undefined, raw)).toBe(128);
  expect(() => resolveMaxQuestions(0)).toThrow("positive integer");
  const previous = process.env.JEVGREP_MAX_QUESTIONS;
  process.env.JEVGREP_MAX_QUESTIONS = "7";
  try {
    expect(resolveMaxQuestions()).toBe(7);
  } finally {
    if (previous === undefined) delete process.env.JEVGREP_MAX_QUESTIONS;
    else process.env.JEVGREP_MAX_QUESTIONS = previous;
  }
});

type RequestState = {
  items?: Array<{ path: string; kind: string }>;
  path?: string;
  declarations?: Array<{ startLine: number; endLine: number }>;
  criteria?: { relevance: string };
  guidance?: string;
};

async function searchFixture(
  files: Record<string, string>,
  query: string,
  options: Partial<Omit<SearchInput, "root" | "query" | "signal">>,
  answer: (request: EvaluationRequest, state: RequestState) => Record<string, number>,
) {
  const root = await mkdtemp(join(tmpdir(), "jg-gaps-"));
  const requests: EvaluationRequest[] = [];
  try {
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, content);
    }
    let requestsMade = 0;
    const result = await retrieve(
      { root, query, signal: new AbortController().signal, ...options },
      {
        get requests() {
          return requestsMade;
        },
        async evaluate(request) {
          requestsMade++;
          requests.push(request);
          return answer(request, request.state as RequestState);
        },
      },
    );
    return { result, requests };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function positiveAnswers(request: EvaluationRequest) {
  return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.9]));
}

testIfDocker("maxQuestions caps navigation batches and source declaration batches", async () => {
  const files = Object.fromEntries(
    ["a", "b", "c", "d", "e"].map((name) => [`${name}.ts`, "export const value = 1;\n"]),
  );
  const navigation = await searchFixture(
    files,
    "where is value",
    { maxQuestions: 2 },
    (request, state) => {
      if (!state.items) return positiveAnswers(request);
      return Object.fromEntries(state.items.map((_, index) => [`q${index}`, 0.9]));
    },
  );
  const batches = navigation.requests
    .map((request) => (request.state as RequestState).items?.length)
    .filter((length): length is number => length !== undefined);
  expect(batches.every((length) => length <= 2)).toBe(true);
  expect(batches).toContain(2);
  expect(navigation.result.files.map((file) => file.path).sort()).toEqual([
    "a.ts",
    "b.ts",
    "c.ts",
    "d.ts",
    "e.ts",
  ]);

  const source = await searchFixture(
    { "notes.txt": `${"alpha word\n".repeat(1500)}` },
    "alpha word",
    { maxQuestions: 2, mode: "code" },
    positiveAnswers,
  );
  const groups = source.requests
    .map((request) => (request.state as RequestState).declarations)
    .filter((declarations): declarations is NonNullable<RequestState["declarations"]> =>
      Boolean(declarations?.length),
    );
  expect(groups.length).toBeGreaterThan(0);
  expect(groups.every((group) => group.length <= 2)).toBe(true);
  expect(groups.some((group) => group.length === 2)).toBe(true);
});

testIfDocker(
  "an HTTP 400 question cap is halved until the batch fits, and other 400s drop it",
  async () => {
    for (const message of ["at most 2 questions", "bad request"] as const) {
      const root = await mkdtemp(join(tmpdir(), "jg-question-cap-"));
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as {
            state: { items?: unknown[] };
            questions: Record<string, unknown>;
          };
          const count = Object.keys(body.questions).length;
          if (body.state.items && count > 2) return Response.json({ message }, { status: 400 });
          return Response.json({
            answers: Object.fromEntries(
              Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.9 }]),
            ),
          });
        },
      });
      try {
        for (const name of ["a", "b", "c", "d"])
          await writeFile(join(root, `${name}.ts`), "export const value = 1;\n");
        const signal = new AbortController().signal;
        const result = await retrieve(
          { root, query: "where is value", signal },
          createEvaluator({
            apiKey: "fixture",
            provider: "vercel",
            fetch: routeProviderFetch(fetch, `http://127.0.0.1:${server.port}`),
            signal,
          }),
        );
        if (message === "at most 2 questions") {
          expect(result.status).toBe("complete");
          expect(result.files.map((file) => file.path).sort()).toEqual([
            "a.ts",
            "b.ts",
            "c.ts",
            "d.ts",
          ]);
          expect(result.issues).toEqual([]);
        } else {
          expect(result.status).toBe("incomplete");
          expect(result.files).toEqual([]);
          expect(result.issues).toContainEqual({ kind: "provider", count: 1 });
        }
      } finally {
        server.stop(true);
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  30_000,
);

testIfDocker(
  "docs mode asks for facts and auto-selects when most files are markdown or text",
  async () => {
    const prose = Object.fromEntries([
      ...Array.from({ length: 8 }, (_, index) => [`note-${index}.md`, "A fact.\n"]),
      ...Array.from({ length: 2 }, (_, index) => [`code-${index}.ts`, "export const value = 1;\n"]),
    ]);
    const code = Object.fromEntries([
      ...Array.from({ length: 7 }, (_, index) => [`note-${index}.md`, "A fact.\n"]),
      ...Array.from({ length: 3 }, (_, index) => [`code-${index}.ts`, "export const value = 1;\n"]),
    ]);
    const fact = "Does this block state facts, rules or decisions that answer the query?";
    async function framingOf(files: Record<string, string>, mode?: SearchInput["mode"]) {
      const searched = await searchFixture(
        files,
        "which fact is recorded",
        { mode },
        positiveAnswers,
      );
      const navigation = searched.requests.find((request) => (request.state as RequestState).items);
      const evidence = searched.requests.find(
        (request) => (request.state as RequestState).criteria,
      );
      const instruction = Object.values(navigation?.questions ?? {})[0] as { instructions: string };
      return {
        instruction: instruction.instructions,
        relevance: (evidence?.state as RequestState).criteria?.relevance ?? "",
        guidance: (evidence?.state as RequestState).guidance ?? "",
        roles: searched.result.files[0]?.roles ?? [],
      };
    }
    const docs = await framingOf(prose);
    expect(docs.instruction).toContain("facts, rules, or decisions");
    expect(docs.instruction).not.toContain("implementation");
    expect(docs.relevance.startsWith(fact)).toBe(true);
    expect(docs.guidance).not.toContain("implementing and testing");
    expect(docs.roles).toEqual(["fact", "rule", "decision", "reference", "background"]);
    const mixed = await framingOf(code);
    expect(mixed.instruction).toContain("implementation");
    expect(mixed.guidance).toContain("implementing and testing");
    const forced = await framingOf(
      Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [`code-${index}.ts`, "export const value = 1;\n"]),
      ),
      "docs",
    );
    expect(forced.relevance.startsWith(fact)).toBe(true);
    const forcedCode = await framingOf(
      Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [`note-${index}.md`, "A fact.\n"]),
      ),
      "code",
    );
    expect(forcedCode.instruction).toContain("implementation");
  },
);

testIfDocker(
  "docs mode admits filename matches above 0.4 and keeps other files at 0.5",
  async () => {
    const files = {
      "other.md": "unrelated notes\n",
      "meeting.md": "the word meeting appears once\n",
      "debt.txt": "debt is mentioned\n",
      "top/meeting-debt.md": "the meeting debt is 12\n",
      "top/notes/secret.md": "DO_NOT_ADMIT\n",
      "keep.md": "kept because the score is high\n",
    };
    const scores: Record<string, number> = {
      "other.md": 0.45,
      "meeting.md": 0.4,
      "debt.txt": 0.41,
      "top/meeting-debt.md": 0.45,
      "top/notes": 0.45,
      "keep.md": 0.8,
    };
    const answer = (request: EvaluationRequest, state: RequestState) => {
      if (!state.items) return positiveAnswers(request);
      return Object.fromEntries(
        state.items.map((item, index) => [`q${index}`, scores[item.path] ?? 0]),
      );
    };
    const docs = await searchFixture(
      files,
      "Where is the meeting debt recorded?",
      { mode: "docs" },
      answer,
    );
    expect(docs.result.files.map((file) => file.path).sort()).toEqual(
      ["debt.txt", "keep.md", "top/meeting-debt.md"].sort(),
    );
    expect(JSON.stringify(docs.requests)).not.toContain("DO_NOT_ADMIT");
    const code = await searchFixture(
      files,
      "Where is the meeting debt recorded?",
      { mode: "code" },
      answer,
    );
    expect(code.result.files.map((file) => file.path)).toEqual(["keep.md"]);
  },
);

testIfDocker(
  "docs mode splits markdown on headings, including headings inside fences",
  async () => {
    const long = `# Alpha\n${"alpha line\n".repeat(400)}# Beta\nbeta answers the query\n`;
    const betaLine = long.split("\n").findIndex((line) => line.startsWith("# Beta")) + 1;
    const fenced = "# Real\n\n```\n# not a heading\n```\n\n# Next\nnext section\n";
    const nextLine = fenced.split("\n").findIndex((line) => line.startsWith("# Next")) + 1;
    const searched = await searchFixture(
      { "long.md": long, "fenced.md": fenced },
      "what does beta answer",
      { mode: "docs" },
      positiveAnswers,
    );
    const starts = (path: string) =>
      [
        ...new Set(
          searched.requests
            .flatMap((request) => {
              const state = request.state as RequestState;
              return state.path === path ? (state.declarations ?? []) : [];
            })
            .map((declaration) => declaration.startLine),
        ),
      ].sort((a, b) => a - b);
    expect(starts("long.md")).toEqual([1, betaLine]);
    expect(starts("fenced.md")).toEqual([1, nextLine]);
    const code = await searchFixture(
      { "long.md": long },
      "what does beta answer",
      { mode: "code" },
      positiveAnswers,
    );
    const codeStarts = code.requests
      .flatMap((request) => {
        const state = request.state as RequestState;
        return state.path === "long.md" ? (state.declarations ?? []) : [];
      })
      .map((declaration) => declaration.startLine);
    expect(codeStarts.some((start) => start > 1 && start < betaLine)).toBe(true);
  },
);
