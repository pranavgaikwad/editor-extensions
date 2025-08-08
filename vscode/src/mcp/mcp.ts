import { z } from "zod";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TaskManager } from "./taskManager";
import { ExtensionState } from "../extensionState";

export class AnalysisMcpServer {
  private server: McpServer;
  private taskManager: TaskManager;

  constructor(
    private readonly state: ExtensionState,
    private readonly workspaceDir: string,
  ) {
    this.server = new McpServer({
      name: "Konveyor Server Providing Analysis Tools",
      version: "1.0.0",
    });

    this.taskManager = new TaskManager(this.workspaceDir);
  }

  async initialize(transport: Transport): Promise<void> {
    // this.server.tool(
    //   "howToMigrateAnApplicationUsingKai",
    //   "This tool gives you instructions on how to use different Konveyor tools to migrate an application. Call this function before calling any other function",
    //   this.howToMigrateAnApplicationUsingKaiCallback,
    // );
    this.server.tool(
      "listFilesWithAnalysisIssues",
      "List all files that have analysis issues identified in them",
      this.listFilesWithAnalysisIssuesCallback,
    );
    this.server.tool(
      "getAnalysisIssuesInFile",
      "List all issues identified in the given file",
      {
        file: z.string().describe("The file to get analysis issues for"),
      },
      this.listAnalysisIssuesInFileCallback,
    );
    this.server.tool(
      "getNewAnalysisIssues",
      "List all new issues in the project since the last call to listFilesWithAnalysisIssues",
      this.getNewAnalysisIssuesCallback,
    );
    return this.server.connect(transport);
  }

  private howToMigrateAnApplicationUsingKaiCallback: ToolCallback = async () => {
    return {
      content: [
        {
          type: "text",
          text: "To migrate an application using Kai, you need to follow these steps:",
        },
      ],
    };
  };

  private listFilesWithAnalysisIssuesCallback: ToolCallback = async () => {
    try {
      await this.waitForAnalysisCompletion();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              Array.from(
                new Set(this.taskManager.getCurrentAnalysisIssues().map((obj) => obj.relativePath)),
              ),
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting files: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  };

  private listAnalysisIssuesInFileCallback: ToolCallback<{ file: z.ZodString }> = async (
    args,
    _extra,
  ) => {
    try {
      const { file } = args;
      await this.waitForAnalysisCompletion();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              Array.from(
                new Set(
                  this.taskManager
                    .getCurrentAnalysisIssues()
                    .filter(
                      (t) =>
                        t.uri.fsPath === file ||
                        t.relativePath === file ||
                        t.relativePath.endsWith(file),
                    )
                    .map((issue) => issue.diagnostic.message),
                ),
              ),
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting files: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  };

  private getNewAnalysisIssuesCallback: ToolCallback = async () => {
    try {
      await this.waitForAnalysisCompletion();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              this.taskManager.getNewTasks().reduce(
                (acc, issue) => {
                  const relativePath = issue.relativePath;
                  const existingGroup = acc.find((group) => group.relativePath === relativePath);
                  if (existingGroup) {
                    existingGroup.issues.push(issue.diagnostic.message);
                  } else {
                    acc.push({
                      relativePath,
                      issues: [issue.diagnostic.message],
                    });
                  }
                  return acc;
                },
                [] as Array<{ relativePath: string; issues: string[] }>,
              ),
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting files: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  };

  private waitForAnalysisCompletion = async (): Promise<void> => {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 30000);

      const interval = setInterval(() => {
        const isAnalyzing = this.state.data.isAnalyzing;
        const isAnalysisScheduled = this.state.data.isAnalysisScheduled;

        if (!isAnalysisScheduled && !isAnalyzing) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 1000);
    });
  };
}
