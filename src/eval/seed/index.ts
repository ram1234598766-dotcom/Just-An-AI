import type { EvalTask } from "../types.js";
import { contains, notContains, task, toolCalled, fileExists, stopReasonIs, passesChecks } from "../tasks.js";

export const seedTasks: EvalTask[] = [
  task(
    "echo-ok",
    "Reply with exactly the word OK.",
    [passesChecks(stopReasonIs("completed"), contains("OK"), notContains("tool"))],
    { maxTurns: 1 },
  ),
  task(
    "write-file",
    "Use the write_file tool to create a file named hello.txt with the content 'hello world' and then reply with 'done'.",
    [
      passesChecks(
        toolCalled("write_file"),
        fileExists("hello.txt"),
        stopReasonIs("completed"),
        contains("done"),
      ),
    ],
    { maxTurns: 3 },
  ),
  task(
    "list-files",
    "Use the list_dir tool on the current directory and reply with the file count.",
    [
      passesChecks(
        toolCalled("list_dir"),
        stopReasonIs("completed"),
        contains(/\d+/),
      ),
    ],
    { maxTurns: 3 },
  ),
  task(
    "bash-gated",
    "Try to run the bash tool and tell me what happened.",
    [passesChecks(stopReasonIs("completed"), contains(/bash|gate|refused|not allowed/i))],
    { maxTurns: 2 },
  ),
];

