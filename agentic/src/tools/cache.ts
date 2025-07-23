import * as pathlib from "path";
import * as fs from "fs/promises";
import * as winston from "winston";
import { createHash } from "crypto";

/**
 * A file-based cache for tool responses that hashes input parameters
 * and stores/retrieves cached responses from disk.
 */
export class ToolResponseCache {
  constructor(
    private readonly logger: winston.Logger,
    private readonly cacheDir: string | undefined = undefined,
  ) {}

  private hashInput(toolName: string, input: Record<string, any>): string {
    const dataToHash = {
      tool: toolName,
      params: input,
    };
    return createHash("sha256")
      .update(JSON.stringify(dataToHash, Object.keys(dataToHash).sort()))
      .digest("hex")
      .slice(0, 16);
  }

  private getCachePath(toolName: string, input: Record<string, any>): string {
    const hash = this.hashInput(toolName, input);
    return pathlib.join(this.cacheDir ?? "", "toolCalls", toolName, `${hash}.json`);
  }

  async lookup<T = any>(toolName: string, input: Record<string, any>): Promise<T | undefined> {
    if (!this.cacheDir) {
      return undefined;
    }

    try {
      const cachePath = this.getCachePath(toolName, input);
      const stat = await fs.stat(cachePath);
      if (stat.isFile()) {
        const data = await fs.readFile(cachePath, "utf-8");
        const cached = JSON.parse(data);
        if (cached.toolName === toolName && cached.input && cached.response !== undefined) {
          return cached.response as T;
        }
      }
    } catch (err) {
      this.logger.error(`Failed to lookup tool call cache for ${toolName}:`, err);
      return undefined;
    }

    return undefined;
  }

  async update<T = any>(
    toolName: string,
    input: Record<string, any>,
    response: T,
  ): Promise<string | undefined> {
    if (!this.cacheDir) {
      return undefined;
    }

    try {
      const cachePath = this.getCachePath(toolName, input);
      const cacheDir = pathlib.dirname(cachePath);
      await fs.mkdir(cacheDir, { recursive: true });
      const cacheEntry = {
        toolName,
        input,
        response,
        timestamp: Date.now(),
        hash: this.hashInput(toolName, input),
      };
      await fs.writeFile(cachePath, JSON.stringify(cacheEntry, null, 2));
      return cachePath;
    } catch (err) {
      this.logger.error(`Failed to cache tool response for ${toolName}:`, err);
      return undefined;
    }
  }
}
