import { EOL } from "os";
import * as fs from "fs";
import { Readable } from "stream";
import { createPipelineInternal, Globals } from "./pipeline";
import { Step, RunResult } from "./publicInterfaces";

const tempy = require("tempy");

describe("task scheduling", () => {
  const graph = {
    A: { location: "a", dependencies: ["B"] },
    B: { location: "b", dependencies: [] },
  };

  test("tological steps wait for dependencies to be done", async () => {
    const tracingContext = makeTestEnvironment();
    const step = tracingContext.makeStep();

    await createPipelineInternal(graph, getGlobals())
      .addTopologicalStep(step)
      .go();

    const expected = [
      step.started("/b"),
      step.finished("/b"),
      step.started("/a"),
      step.finished("/a"),
    ];

    expected.forEach((e, i) => expect(e).toBe(tracingContext.logs[i]));
  });

  test("parallel steps dont wait for dependencies to be done", async () => {
    const tracingContext = makeTestEnvironment();
    const step = tracingContext.makeStep();

    await createPipelineInternal(graph, getGlobals())
      .addParallelStep(step)
      .go();

    const expected = [
      step.started("/b"),
      step.started("/a"),
      step.finished("/b"),
      step.finished("/a"),
    ];

    expected.forEach((e, i) => expect(e).toBe(tracingContext.logs[i]));
  });

  test("tological steps wait for the previous step", async () => {
    const tracingContext = makeTestEnvironment();
    const step1 = tracingContext.makeStep();
    const step2 = tracingContext.makeStep();

    await createPipelineInternal(graph, getGlobals())
      .addTopologicalStep(step1)
      .addTopologicalStep(step2)
      .go();

    const expected = [
      step1.started("/b"),
      step1.finished("/b"),
      step2.started("/b"),
      step2.finished("/b"),
    ];

    expected.forEach((e, i) =>
      expect(e).toBe(
        tracingContext.logs.filter((line) => line.includes("/b"))[i]
      )
    );
  });

  test("parallel steps wait for the previous step", async () => {
    const tracingContext = makeTestEnvironment();
    const step1 = tracingContext.makeStep();
    const step2 = tracingContext.makeStep();

    await createPipelineInternal(graph, getGlobals())
      .addParallelStep(step1)
      .addParallelStep(step2)
      .go();

    const expected = [
      step1.started("/b"),
      step1.finished("/b"),
      step2.started("/b"),
      step2.finished("/b"),
    ];

    expected.forEach((e, i) =>
      expect(e).toBe(
        tracingContext.logs.filter((line) => line.includes("/b"))[i]
      )
    );
  });
});

describe("failing steps", () => {
  test("a failing step fails the entire process", async () => {
    const graph = {
      A: { location: "a", dependencies: [] },
    };

    const tracingContext = makeTestEnvironment();
    const step = tracingContext.makeStep({ success: false });
    const globals = getGlobals();

    await createPipelineInternal(graph, globals).addParallelStep(step).go();

    expect(globals.exitCode).toBe(1);
  });

  test("the second step is not run if the first one fails", async () => {
    const graph = {
      A: { location: "a", dependencies: [] },
    };

    const tracingContext = makeTestEnvironment();
    const step1 = tracingContext.makeStep({ success: false });
    const step2 = tracingContext.makeStep();

    await createPipelineInternal(graph, getGlobals())
      .addParallelStep(step1)
      .addParallelStep(step2)
      .go();

    expect(
      tracingContext.logs.filter((l) => l.includes(step1.started("/a"))).length
    ).toBe(1);
    expect(
      tracingContext.logs.filter((l) => l.includes(step2.started("/a"))).length
    ).toBe(0);
  });
});

describe("output", () => {
  test("validating step output", async () => {
    const graph = {
      A: { location: "a", dependencies: [] },
    };

    const tracingContext = makeTestEnvironment();
    const step = tracingContext.makeStep({
      stdout: "step stdout",
      stderr: "step stderr",
    });

    const globals = getGlobals();
    await createPipelineInternal(graph, globals).addParallelStep(step).go();

    const expectedStdout: string[] = [
      ` / Done ${step.name} in A`,
      ` | STDOUT`,
      ` |  | step stdout`,
      ` | STDERR`,
      ` |  | step stderr`,
      ` \\ Done ${step.name} in A`,
      ``,
    ];
    const expectedStderr: string[] = [];

    globals.validateOuput(expectedStdout, expectedStderr);
  });

  test("validating step output with nothing written to console", async () => {
    const graph = {
      A: { location: "a", dependencies: [] },
    };

    const tracingContext = makeTestEnvironment();
    const step = tracingContext.makeStep();

    const globals = getGlobals();
    await createPipelineInternal(graph, globals).addParallelStep(step).go();

    const expectedStdout: string[] = [`Done ${step.name} in A`, ""];
    const expectedStderr: string[] = [];

    globals.validateOuput(expectedStdout, expectedStderr);
  });

  test("validating failing step output with nothing written to console", async () => {
    const graph = {
      A: { location: "a", dependencies: [] },
    };

    const tracingContext = makeTestEnvironment();
    const step = tracingContext.makeStep({ success: false });

    const globals = getGlobals();
    await createPipelineInternal(graph, globals).addParallelStep(step).go();

    const expectedStdout: string[] = [];
    const expectedStderr: string[] = [`Failed ${step.name} in A`, ``];

    globals.validateOuput(expectedStdout, expectedStderr);
  });

  test("validating throwing step output", async () => {
    const graph = {
      A: { location: "a", dependencies: [] },
    };

    const tracingContext = makeTestEnvironment();
    const step = tracingContext.makeStep({
      success: new Error("failing miserably"),
      stderr: "step stderr",
      stdout: "step stdout",
    });

    const globals = getGlobals();
    await createPipelineInternal(graph, globals).addParallelStep(step).go();

    const expectedStderr: string[] = [
      ` / Failed ${step.name} in A`,
      ` | STDOUT`,
      ` |  | step stdout`,
      ` | STDERR`,
      ` |  | step stderr`,
      ` |  | stack trace for following error: failing miserably`,
      ` \\ Failed ${step.name} in A`,
      ``,
    ];
    const expectedStdout: string[] = [];

    globals.validateOuput(expectedStdout, expectedStderr);
  });

  test("validate output with two steps", async () => {
    const graph = {
      A: { location: "a", dependencies: [] },
    };

    const tracingContext = makeTestEnvironment();
    const step1 = tracingContext.makeStep({
      stdout: "step1 stdout",
    });
    const step2 = tracingContext.makeStep({
      stdout: "step2 stdout",
    });

    const globals = getGlobals();
    await createPipelineInternal(graph, globals)
      .addParallelStep(step1)
      .addTopologicalStep(step2)
      .go();

    const expectedStdout: string[] = [
      ` / Done ${step1.name} in A`,
      ` | STDOUT`,
      ` |  | step1 stdout`,
      ` \\ Done ${step1.name} in A`,
      ``,
      ` / Done ${step2.name} in A`,
      ` | STDOUT`,
      ` |  | step2 stdout`,
      ` \\ Done ${step2.name} in A`,
      ``,
    ];
    const expectedStderr: string[] = [];

    globals.validateOuput(expectedStdout, expectedStderr);
  });

  test("the message of the failing step is output at the end", async () => {
    const graph = {
      A: { location: "a", dependencies: ["B"] },
      B: { location: "b", dependencies: [] },
    };

    const run = (cwd: string): RunResult => {
      if (cwd === "/a") {
        return {
          promise: Promise.resolve(true),
          stdout: createReadStream("step1 stdout"),
          stderr: createReadStream(""),
        };
      } else {
        return {
          promise: Promise.resolve(false),
          stdout: createReadStream(""),
          stderr: createReadStream("step1 failed"),
        };
      }
    };

    const globals = getGlobals(true);

    await createPipelineInternal(graph, globals)
      .addParallelStep({ name: "step1", run })
      .go();

    const expectedStdout: string[] = [
      ` / Done step1 in A`,
      ` | STDOUT`,
      ` |  | step1 stdout`,
      ` \\ Done step1 in A`,
      ``,
      ` / Failed step1 in B`,
      ` | STDERR`,
      ` |  | step1 failed`,
      ` \\ Failed step1 in B`,
      ``,
    ];

    globals.validateOuput(expectedStdout, expectedStdout);
  });
});

type TestingGlobals = Globals & {
  validateOuput(expectedStdout: string[], expectedStderr: string[]): void;
  stdout: string[];
  stderr: string[];
  exitCode: number;
};

function getGlobals(stdoutAsStderr = false): TestingGlobals {
  const _stdout: string[] = [];
  const _stderr: string[] = stdoutAsStderr ? _stdout : [];
  let _exitCode = 0;

  return {
    validateOuput(expectedStdout: string[], expectedStderr: string[]): void {
      expect(_stderr.length).toBe(expectedStderr.length);
      expect(_stdout.length).toBe(expectedStdout.length);
      expectedStdout.forEach((m, i) => expect(m).toBe(_stdout[i]));
      expectedStderr.forEach((m, i) => expect(m).toBe(_stderr[i]));
    },
    logger: {
      log(message: string): void {
        message.split(EOL).forEach((m) => _stdout.push(m));
      },
      error(message: string): void {
        message.split(EOL).forEach((m) => _stderr.push(m));
      },
    },
    cwd(): string {
      return "/";
    },
    exit(int: number): void {
      _exitCode = int;
    },
    get stdout(): string[] {
      return _stdout;
    },
    get stderr(): string[] {
      return _stderr;
    },
    get exitCode(): number {
      return _exitCode;
    },
    errorFormatter(err: Error): string {
      return `stack trace for following error: ${err.message}`;
    },
  };
}

type StepResult = {
  success: true | false | Error;
  stdout: string;
  stderr: string;
};

type StepResultOverride = {
  success?: true | false | Error;
  stdout?: string;
  stderr?: string;
};

type StepMock = Step & {
  started: (cwd: string) => string;
  finished: (cwd: string) => string;
};

function createReadStream(content: string): Readable {
  const tmpFile = tempy.file();
  fs.writeFileSync(tmpFile, content);
  return fs.createReadStream(tmpFile);
}

function makeTestEnvironment(): {
  logs: string[];
  makeStep: (desiredResult?: StepResultOverride) => StepMock;
} {
  const logs: string[] = [];
  return {
    logs,
    makeStep(desiredResult?: StepResultOverride): StepMock {
      const name = Math.random().toString(36);
      const defaultResult: StepResult = {
        success: true,
        stdout: "",
        stderr: "",
      };

      const result = desiredResult
        ? { ...defaultResult, ...desiredResult }
        : defaultResult;

      const messages = {
        started(cwd: string): string {
          return `called ${name} for ${cwd}`;
        },
        finished(cwd: string): string {
          return `finished ${name} for ${cwd}`;
        },
      };

      const stdout = createReadStream(result.stdout);
      const stderr = createReadStream(result.stderr);

      const run = (cwd: string): RunResult => {
        logs.push(messages.started(cwd));
        return {
          stdout,
          stderr,
          promise: new Promise<boolean>((resolve, reject) => {
            if (typeof result.success === "object") {
              setTimeout(() => {
                reject(result.success);
              }, 50);
            } else {
              setTimeout(() => {
                logs.push(messages.finished(cwd));
                resolve(result.success as boolean);
              }, 50);
            }
          }),
        };
      };

      return { run, name, ...messages };
    },
  };
}
