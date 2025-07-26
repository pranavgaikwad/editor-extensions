import * as winston from "winston";
import {
  BaseMessage,
  HumanMessage,
  isBaseMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type StoredMessage,
} from "@langchain/core/messages";
import { FileBasedResponseCache } from "@editor-extensions/agentic";
import { type BasePromptValueInterface } from "@langchain/core/prompt_values";
import { type BaseLanguageModelInput } from "@langchain/core/language_models/base";

export function getCacheForModelProvider(
  enabled: boolean,
  logger: winston.Logger,
  cacheDir: string,
  isTracer: boolean = false,
): FileBasedResponseCache<BaseLanguageModelInput, BaseMessage> {
  return new FileBasedResponseCache<BaseLanguageModelInput, BaseMessage>(
    enabled,
    (data: BaseLanguageModelInput | BaseMessage) =>
      isTracer ? prettyPrint(data) : JSON.stringify(serializeLLMMessages(data)),
    (data: string) => deserializeLLMMessages(data)[0],
    cacheDir,
    logger,
  );
}

export function deserializeLLMMessages(data: string): BaseMessage[] {
  const rawParsed = JSON.parse(data);
  if (Array.isArray(rawParsed) && (rawParsed as StoredMessage[])) {
    return mapStoredMessagesToChatMessages(rawParsed);
  }
  throw new Error("Unable to deserialize data");
}

export function serializeLLMMessages(data: BaseLanguageModelInput | BaseMessage): StoredMessage[] {
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

function isBasePromptValueInterface(data: unknown): data is BasePromptValueInterface {
  return (
    typeof data === "object" &&
    data !== null &&
    "toString" in data &&
    "toChatMessages" in data &&
    "toJSON" in data
  );
}

function prettyPrint(data: BaseLanguageModelInput | BaseMessage): string {
  return mapStoredMessagesToChatMessages(serializeLLMMessages(data).filter(Boolean))
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
