import { z } from "zod";
import * as pathlib from "path";
import * as vscode from "vscode";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ExtensionState } from "../extensionState";
import { fileUriToPath } from "../utilities/configuration";
import { AnalysisDiagnosticTask, DiagnosticTaskManager } from "../taskManager/taskManager";

export class AnalysisMcpServer {
  private server: McpServer;
  private taskManager: DiagnosticTaskManager;

  constructor(
    private readonly state: ExtensionState,
    private readonly workspaceDir: string,
  ) {
    this.server = new McpServer({
      name: "Konveyor Server Providing Analysis Tools",
      version: "1.0.0",
    });
    this.taskManager = new DiagnosticTaskManager([]);
  }

  async initialize(transport: Transport): Promise<void> {
    this.server.tool(
      "howToMigrateAnApplicationUsingKonveyor",
      "This tool gives you instructions on how to use different Konveyor tools to migrate an application. Call this function before calling any other function provided by Konveyor.",
      this.howToMigrateAnApplicationUsingKonveyorCallback,
    );
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
    // this.server.tool(
    //   "getNextAnalysisIssue",
    //   "Get the next analysis issue to fix in the project",
    //   this.getNextAnalysisIssueCallback,
    // );
    this.server.tool(
      "getKnockOnIssues",
      "List all new issues in the project since the last call to listFilesWithAnalysisIssues",
      this.getKnockOnIssuesCallback,
    );
    // this.server.tool(
    //   "resetKnockOnIssues",
    //   "Resets the state that computes differences in issues prior and after a change was made.",
    //   this.resetKnockOnIssuesCallback,
    // );
    return this.server.connect(transport);
  }

  private howToMigrateAnApplicationUsingKonveyorCallback: ToolCallback = async () => {
    return {
      content: [
        {
          type: "text",
          text: `Konveyor provides a set of static source code analysis tools to identify migration issues in the code.
** Workflow to fix issues**
1. List files with analysis issues using \`listFilesWithAnalysisIssuesCallback\` tool.
2. Start fixing issues in files one file at a time. Try to solve as many issues in a file as possible in one edit.\
**It is important to solve all issues in a file before moving to the next file.**
3. Once you fix a file, call \`getKnockOnIssues\` function which will return a list of issues caused by the changes you made.\
This compares the issues present before you made the changes and the issues present after you made the changes to compute the new issues.\
Fix these new issues before moving onto the next file. It is OK if you cannot address some of the knock-on issues. **You can also skip a knock-on issue if you think its not related to the changes you made.**.
4. Repeat until all issues are fixed or you are unable to fix any more issues. **It is important to call \`listFilesWithAnalysisIssues\` before moving onto the next file to ensure you always get uptodate list of issues.**
`,
        },
      ],
    };
  };

  private getNextAnalysisIssueCallback: ToolCallback = async () => {
    try {
      await this.waitForAnalysisCompletion();
      this.taskManager.reset();
      const tasksByUri = this.taskManager
        .getCurrentTasks()
        .filter((t) => t instanceof AnalysisDiagnosticTask)
        .reduce(
          (acc, task) => {
            const uri = task.getUri().toString();
            if (!acc[uri]) {
              acc[uri] = [];
            }
            acc[uri].push(task);
            return acc;
          },
          {} as Record<string, AnalysisDiagnosticTask[]>,
        );

      const tasks = Object.entries(tasksByUri)
        .map(([uri, tasks]) => ({ uri, tasks }))
        .sort((a, b) =>
          a.uri.endsWith("pom.xml")
            ? -1
            : b.uri.endsWith("pom.xml")
              ? 1
              : a.uri.localeCompare(b.uri),
        );
      const nextTask = tasks.length ? tasks[0] : null;
      let nextIssue = "There are no more analysis issues to fix in the project";
      if (nextTask) {
        nextIssue = `File: ${toRelativePath(nextTask.tasks[0].getUri(), this.workspaceDir)}\nIssues:\n${nextTask.tasks.map((t) => t.toString()).join("\n")}`;
      }
      return {
        content: [
          {
            type: "text",
            text: nextIssue,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting next analysis issue: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
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
                new Set(
                  this.taskManager
                    .getCurrentTasks()
                    .filter((t) => t instanceof AnalysisDiagnosticTask)
                    .map((t) => toRelativePath(t.getUri(), this.workspaceDir)),
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
                    .getCurrentTasks()
                    .filter(
                      (t) =>
                        (t.getUri().fsPath === file ||
                          toRelativePath(t.getUri(), this.workspaceDir) === file ||
                          toRelativePath(t.getUri(), this.workspaceDir).endsWith(file)) &&
                        t instanceof AnalysisDiagnosticTask,
                    )
                    .map((t) => t.toString()),
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

  private getKnockOnIssuesCallback: ToolCallback = async () => {
    try {
      await this.waitForAnalysisCompletion();
      const knockOnTasks = this.taskManager
        .getKnockOnTasks()
        .currentTasks.reduce(
          (acc, issue) => {
            const relativePath = toRelativePath(issue.getUri(), this.workspaceDir);
            const existingGroup = acc.find((group) => group.relativePath === relativePath);
            if (existingGroup) {
              existingGroup.issues.add(issue.toString());
            } else {
              acc.push({
                relativePath,
                issues: new Set([issue.toString()]),
              });
            }
            return acc;
          },
          [] as Array<{ relativePath: string; issues: Set<string> }>,
        )
        .map((group) => ({
          relativePath: group.relativePath,
          issues: Array.from(group.issues),
        }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(knockOnTasks, null, 2),
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

  private resetKnockOnIssuesCallback: ToolCallback = async () => {
    await this.waitForAnalysisCompletion();
    this.taskManager.reset();
    return {
      content: [{ type: "text", text: "Knock-on issues reset" }],
    };
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

function toRelativePath(uri: vscode.Uri, workspaceDir: string): string {
  return pathlib.relative(fileUriToPath(workspaceDir), fileUriToPath(uri.fsPath));
}
