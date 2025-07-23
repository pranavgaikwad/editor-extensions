import { type BaseMessage } from "@langchain/core/messages";
import { type BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseLanguageModelInput } from "@langchain/core/language_models/base";

export type SupportedModelProviders =
  | "AzureChatOpenAI"
  | "ChatBedrock"
  | "ChatDeepSeek"
  | "ChatGoogleGenerativeAI"
  | "ChatOllama"
  | "ChatOpenAI";

/**
 * The config for a model. This is parsed from the yaml file and contains args as-is.
 */
export interface KaiModelConfig {
  provider: SupportedModelProviders;
  args: Record<string, any>;
  template?: string;
  llamaHeader?: boolean;
  llmRetries?: number;
  llmRetryDelay?: number;
}

/**
 * This is the config and environment variables combined used by the model provider to create a model client.
 */
export interface ParsedModelConfig {
  env: Record<string, string>;
  config: KaiModelConfig;
}

export interface ModelCreator {
  defaultArgs(): Record<string, any>;
  validate(args: Record<string, any>, env: Record<string, string>): void;
  create(args: Record<string, any>, env: Record<string, string>): BaseChatModel;
}

export interface ModelCapabilities {
  supportsTools: boolean;
  supportsToolsInStreaming: boolean;
}

export interface ModelProviderCache {
  lookup(input: BaseLanguageModelInput, cacheKey: string): Promise<BaseMessage[] | undefined>;
  update(
    input: BaseLanguageModelInput,
    cacheKey: string,
    value: BaseMessage,
  ): Promise<string | undefined>;
}

export interface ModelProviderTracer {
  trace(
    input: BaseLanguageModelInput,
    cacheKey: string,
    value: BaseMessage,
  ): Promise<string | undefined>;
}
