import expect from "expect";
import * as pathlib from "path";
import * as fs from "fs/promises";
import * as winston from "winston";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { FileBasedLLMCache, FileBasedLLMTracer } from "../cache";

describe("test FSCacheAndTracer", () => {
  const cacheDir = pathlib.join(__dirname, "_cache");
  const traceDir = pathlib.join(__dirname, "_trace");

  const verifyRecordsExist = async (actualBasePath: string | undefined, isJson: boolean) => {
    expect(actualBasePath).toBeDefined();
    const outputFileStat = await fs.stat(
      pathlib.join(actualBasePath ?? "", "output" + (isJson ? ".json" : "")),
    );
    const inputFileStat = await fs.stat(
      pathlib.join(actualBasePath ?? "", "input" + (isJson ? ".json" : "")),
    );
    expect(outputFileStat.isFile()).toBe(true);
    expect(inputFileStat.isFile()).toBe(true);
  };

  const verifyTraceContent = async (
    actualBasePath: string | undefined,
    expectedInputContent: string,
    expectedOutputContent: string,
  ) => {
    const actualOutputContent = await fs.readFile(
      pathlib.join(actualBasePath ?? "", "output"),
      "utf-8",
    );
    expect(actualOutputContent).toBeDefined();
    expect(actualOutputContent).toContain(expectedOutputContent);
    const actualInputContent = await fs.readFile(
      pathlib.join(actualBasePath ?? "", "input"),
      "utf-8",
    );
    expect(actualInputContent).toBeDefined();
    expect(actualInputContent).toContain(expectedInputContent);
  };

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.rm(traceDir, { recursive: true, force: true });
  });

  it("should serialize and deserialize cache data properly when caching simple string input", async () => {
    const fsCache = new FileBasedLLMCache(winston.createLogger({ silent: true }), cacheDir);
    // test basic string input
    const cachePath = await fsCache.update("Hello", "test", new AIMessage("world!"));
    await verifyRecordsExist(cachePath, true);
    const actualOutput = await fsCache.lookup("Hello", "test");
    expect(actualOutput).toBeDefined();
    expect(actualOutput?.[0].content).toBe("world!");
  });

  it("should serialize and deserialize cache data properly when caching list of mixed set of messages", async () => {
    const fsCache = new FileBasedLLMCache(winston.createLogger({ silent: true }), cacheDir);
    // test list of mixed set of messages
    const longInput = [
      new HumanMessage("Hello"),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "whatComesNext",
            args: {
              word: "Hello",
            },
          },
        ],
      }),
      new ToolMessage({
        content: "World!",
        tool_call_id: "test",
      }),
    ];
    const cachePath = await fsCache.update(longInput, "test2", new AIMessage("World!"));
    await verifyRecordsExist(cachePath, true);
    const actualOutput = await fsCache.lookup(longInput, "test2");
    expect(actualOutput).toBeDefined();
    expect(actualOutput?.[0].content).toBe("World!");
  });

  it("should serialize and deserialize data properly when tracing a simple string input", async () => {
    const trace = new FileBasedLLMTracer(winston.createLogger({ silent: true }), traceDir);

    // test basic string input
    const tracePath = await trace.trace("Hello", "test", new AIMessage("world!"));
    await verifyRecordsExist(tracePath, false);
    await verifyTraceContent(
      tracePath,
      `Type: human
Content: Hello`,
      `Type: ai
Content: world!`,
    );
  });

  it("should serialize and deserialize data properly when tracing a list of mixed set of messages", async () => {
    const trace = new FileBasedLLMTracer(winston.createLogger({ silent: true }), traceDir);

    // test list of mixed set of messages
    const longInput = [
      new HumanMessage("Hello"),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "whatComesNext",
            args: {
              word: "Hello",
            },
          },
        ],
      }),
      new ToolMessage({
        content: "World!",
        tool_call_id: "test",
      }),
    ];
    const tracePath = await trace.trace(longInput, "test2", new AIMessage("World!"));
    await verifyRecordsExist(tracePath, false);
    await verifyTraceContent(
      tracePath,
      `Type: human
Content: Hello

------------------------------

Type: ai
Tool Calls: [
  {
    "name": "whatComesNext",
    "args": {
      "word": "Hello"
    }
  }
]

------------------------------

Type: tool
Content: World!`,
      `Type: ai
Content: World!`,
    );
  });
});
