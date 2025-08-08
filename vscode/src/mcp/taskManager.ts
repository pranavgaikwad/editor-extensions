import vscode from "vscode";
import * as pathlib from "path";
import { fileURLToPath } from "url";

export interface FlatDiagnostic {
  uri: vscode.Uri;
  relativePath: string;
  diagnostic: vscode.Diagnostic;
}

export class TaskManager {
  constructor(
    private readonly workspaceDir: string,
    private lastDiagnostics: FlatDiagnostic[] = [],
  ) {}

  init() {
    this.lastDiagnostics = this.getDiagnostics();
  }

  getNewTasks(): FlatDiagnostic[] {
    const currentDiagnostics = this.getDiagnostics();
    const newDiagnostics = currentDiagnostics.filter((d) => !this.lastDiagnostics.includes(d));
    this.lastDiagnostics = currentDiagnostics;
    return newDiagnostics;
  }

  getCurrentAnalysisIssues(): FlatDiagnostic[] {
    this.init();
    return this.getDiagnostics()
      .filter((d) => d.diagnostic.source?.toLowerCase() === "konveyor")
      .filter(Boolean);
  }

  getDiagnostics(): FlatDiagnostic[] {
    return vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) =>
      diagnostics.filter(Boolean).map((d) => ({
        uri: uri,
        relativePath: pathlib.relative(this.workspaceDir, fileUriToPath(uri.fsPath)),
        diagnostic: d,
      })),
    );
  }
}

export function fileUriToPath(path: string): string {
  const cleanPath = path.startsWith("file://") ? fileURLToPath(path) : path;
  return process.platform === "win32" && cleanPath.startsWith("/")
    ? cleanPath.replace("/", "")
    : cleanPath;
}
