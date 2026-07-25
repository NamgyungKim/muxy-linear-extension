import assert from "node:assert/strict";
import test from "node:test";

import { execAsyncFromSync, openRunScript, runModalQuery } from "./find-in-files-test-utils.mjs";

test("Find in Files runScript reuses the previous result after clearing and retyping the same query", async () => {
  let modalOptions = null;
  const calls = [];
  globalThis.muxy = {
    modal: {
      open(options) {
        modalOptions = options;
      },
    },
    execAsync: execAsyncFromSync((argv, options) => {
      calls.push({ argv, options });
      return { exitCode: 0, stdout: "src/main.js:7:needle cached\n" };
    }),
  };

  try {
    await openRunScript("clear-research-cache");

    const first = await runModalQuery(modalOptions, "needle");
    assert.equal(first.emittedItems[0].title, "needle cached");
    assert.deepEqual(modalOptions.onQuery(""), []);
    const second = await runModalQuery(modalOptions, "needle");
    assert.equal(second.emittedItems[0].title, "needle cached");
    assert.equal(calls.length, 1);
  } finally {
    delete globalThis.muxy;
  }
});

test("Find in Files runScript does not start grep fallback after rg throws", async () => {
  let modalOptions = null;
  const calls = [];
  globalThis.muxy = {
    modal: {
      open(options) {
        modalOptions = options;
      },
    },
    execAsync: execAsyncFromSync((argv) => {
      calls.push(argv[0]);
      if (argv[0] === "rg") throw new Error("timed out");
      return { exitCode: 0, stdout: "src/main.js:7:needle fallback\n" };
    }),
  };

  try {
    await openRunScript("rg-timeout-no-grep");

    const result = await runModalQuery(modalOptions, "needle");

    assert.equal(typeof result.immediateItems?.then, "function");
    assert.deepEqual(result.emittedItems, []);
    assert.deepEqual(calls, ["rg"]);
  } finally {
    delete globalThis.muxy;
  }
});

test("Find in Files runScript does not cache an rg execution failure", async () => {
  let modalOptions = null;
  const calls = [];
  globalThis.muxy = {
    modal: {
      open(options) {
        modalOptions = options;
      },
    },
    execAsync: execAsyncFromSync((argv) => {
      calls.push(argv[0]);
      if (calls.length === 1) throw new Error("timed out");
      return { exitCode: 0, stdout: "src/main.js:7:needle retry\n" };
    }),
  };

  try {
    await openRunScript("rg-timeout-retry");

    const failed = await runModalQuery(modalOptions, "needle");
    const retried = await runModalQuery(modalOptions, "needle");

    assert.equal(typeof failed.immediateItems?.then, "function");
    assert.deepEqual(failed.emittedItems, []);
    assert.equal(retried.emittedItems[0].title, "needle retry");
    assert.deepEqual(calls, ["rg", "rg"]);
  } finally {
    delete globalThis.muxy;
  }
});

test("Find in Files runScript falls back to grep when rg is unavailable", async () => {
  let modalOptions = null;
  const calls = [];
  globalThis.muxy = {
    modal: {
      open(options) {
        modalOptions = options;
      },
    },
    execAsync: execAsyncFromSync((argv, options) => {
      calls.push({ argv, options });
      if (argv[0] === "rg") return { exitCode: 127, stdout: "" };
      return { exitCode: 0, stdout: "src/main.js:7:needle fallback\n" };
    }),
  };

  try {
    await openRunScript("grep-fallback");

    const result = await runModalQuery(modalOptions, "needle");

    assert.equal(result.emittedItems[0].title, "needle fallback");
    assert.deepEqual(
      calls.map((call) => call.argv[0]),
      ["rg", "grep"],
    );
  } finally {
    delete globalThis.muxy;
  }
});
