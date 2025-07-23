import * as pathlib from "path";
import * as fs from "fs/promises";
import * as winston from "winston";
import { createHash } from "crypto";
import {
  BaseMessage,
  HumanMessage,
  isBaseMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  StoredMessage,
} from "@langchain/core/messages";
import { BasePromptValueInterface } from "@langchain/core/prompt_values";
import { type BaseLanguageModelInput } from "@langchain/core/language_models/base";

import { type ModelProviderCache, type ModelProviderTracer } from "./types";

/**
 * A cache and tracer that stores LLM responses on disk in a custom format suitable for Kai workflows.
 */
export class FileBasedLLMCache implements ModelProviderCache {
  constructor(
    private logger: winston.Logger,
    private readonly cacheDir: string | undefined = undefined,
  ) {}

  /**
   *
   * @param input The input (prompt or list of messages) passed to the LLM.
   * @param cacheKey A custom key for the cache, cache is located at `<cacheDir>/<cacheKey>/<hash>/(input|output).json`.
   * @returns
   */
  async lookup(
    input: BaseLanguageModelInput,
    cacheKey: string,
  ): Promise<BaseMessage[] | undefined> {
    if (this.cacheDir) {
      try {
        const llmOutputCachePath = pathlib.join(
          pathlib.join(this.cacheDir, cacheKey, hash(input)),
          "output.json",
        );
        const stat = await fs.stat(llmOutputCachePath);
        if (stat.isFile()) {
          const data = await fs.readFile(llmOutputCachePath, "utf-8");
          return deserialize(data);
        }
      } catch (err) {
        this.logger.error("Error looking up cache", { error: err });
      }
    }
    return undefined;
  }

  /**
   *
   * @param input The input (prompt or list of messages) passed to the LLM.
   * @param cacheKey A custom key for the cache, cache is located at `<cacheDir>/<cacheKey>/<hash>/(input|output).json`.
   * @param value The LLM response to cache.
   * @returns The path to the cache file.
   */
  async update(
    input: BaseLanguageModelInput,
    cacheKey: string,
    value: BaseMessage,
  ): Promise<string | undefined> {
    let cachePath: string | undefined;
    if (this.cacheDir) {
      try {
        const { outputRecordPath } = await writeInputAndOutputRecord(
          pathlib.join(this.cacheDir, cacheKey, hash(input)),
          JSON.stringify(serialize(input)),
          JSON.stringify(serialize(value)),
        );
        cachePath = pathlib.dirname(outputRecordPath);
      } catch (err) {
        this.logger.error("Error updating cache", { error: err });
      }
    }
    return cachePath;
  }
}

export class FileBasedLLMTracer implements ModelProviderTracer {
  constructor(
    private logger: winston.Logger,
    private readonly traceDir: string,
  ) {}

  async trace(
    input: BaseLanguageModelInput,
    cacheKey: string,
    value: BaseMessage,
  ): Promise<string | undefined> {
    try {
      const { outputRecordPath } = await writeInputAndOutputRecord(
        pathlib.join(this.traceDir, cacheKey, hash(input)),
        prettyPrint(input),
        prettyPrint(value),
        false,
      );
      return pathlib.dirname(outputRecordPath);
    } catch (err) {
      this.logger.error("Error creating a trace", { error: err });
    }
    return undefined;
  }
}

export class NoCacheNoTrace implements ModelProviderTracer, ModelProviderCache {
  async trace(
    _input: BaseLanguageModelInput,
    _cacheKey: string,
    _value: BaseMessage,
  ): Promise<string | undefined> {
    return undefined;
  }

  async lookup(
    _input: BaseLanguageModelInput,
    _cacheKey: string,
  ): Promise<BaseMessage[] | undefined> {
    return undefined;
  }

  async update(
    _input: BaseLanguageModelInput,
    _cacheKey: string,
    _value: BaseMessage,
  ): Promise<string | undefined> {
    return undefined;
  }
}

function isBasePromptValueInterface(data: unknown): data is BasePromptValueInterface {
  return (
    typeof data === "object" &&
    data !== null &&
    "toString" in data &&
    "toChatMessages" in data &&
    "toJSON" in data
  );
}

function serialize(data: BaseLanguageModelInput | BaseMessage): StoredMessage[] {
  if (data instanceof BaseMessage) {
    return mapChatMessagesToStoredMessages([data]);
  }
  if (typeof data === "string") {
    return mapChatMessagesToStoredMessages([new HumanMessage(data)]);
  }
  if (isBasePromptValueInterface(data)) {
    return mapChatMessagesToStoredMessages(data.toChatMessages());
  }
  if (Array.isArray(data)) {
    return mapChatMessagesToStoredMessages(
      data
        .flatMap((item) => {
          if (isBaseMessage(item)) {
            return item;
          } else if (isBasePromptValueInterface(item)) {
            return item.toChatMessages();
          } else if (typeof item === "string") {
            return [new HumanMessage(item)];
          } else {
            return undefined;
          }
        })
        .filter(Boolean),
    );
  }
  // we dont support other types of messages
  throw new Error("Unable to serialize data");
}

function prettyPrint(data: BaseLanguageModelInput | BaseMessage): string {
  return mapStoredMessagesToChatMessages(serialize(data).filter(Boolean))
    .map((m) => {
      let result = `Type: ${m.getType()}`;
      if (m.content) {
        result += `\nContent: ${m.content}`;
      }
      if (Object.keys(m.additional_kwargs).length > 0) {
        result += `\nKwargs: ${JSON.stringify(m.additional_kwargs, null, 2)}`;
      }
      if (m.getType() === "ai" && (m as any).tool_calls && (m as any).tool_calls.length > 0) {
        result += `\nTool Calls: ${JSON.stringify((m as any).tool_calls, null, 2)}`;
      }
      return result;
    })
    .join("\n\n------------------------------\n\n");
}

async function writeInputAndOutputRecord(
  basePath: string,
  input: string,
  output: string,
  isJson: boolean = true,
): Promise<{
  inputRecordPath: string;
  outputRecordPath: string;
}> {
  const inputRecordPath = pathlib.join(basePath, "input" + (isJson ? ".json" : ""));
  const outputRecordPath = pathlib.join(basePath, "output" + (isJson ? ".json" : ""));
  await fs.mkdir(basePath, { recursive: true });
  await fs.writeFile(inputRecordPath, input);
  await fs.writeFile(outputRecordPath, output);
  return {
    inputRecordPath,
    outputRecordPath,
  };
}

function deserialize(data: string): BaseMessage[] {
  const rawParsed = JSON.parse(data);
  if (Array.isArray(rawParsed) && (rawParsed as StoredMessage[])) {
    return mapStoredMessagesToChatMessages(rawParsed);
  }
  throw new Error("Unable to deserialize data");
}

function hash(input: BaseLanguageModelInput): string {
  return createHash("sha256")
    .update(JSON.stringify(serialize(input)))
    .digest("hex")
    .slice(0, 16);
}
