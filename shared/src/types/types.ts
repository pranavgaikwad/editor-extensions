import { Uri } from "vscode";

export type WebviewType = "sidebar" | "resolution";

export type Severity = "High" | "Medium" | "Low";

export interface Incident {
  uri: string;
  lineNumber?: number;
  severity?: Severity;
  message: string;
  codeSnip?: string;
}

export interface Link {
  url: string;
  title?: string;
}

export type Category = "potential" | "optional" | "mandatory";

export interface Violation {
  description: string;
  category?: Category;
  labels?: string[];
  incidents: Incident[];
  effort?: number;
}

export type ViolationWithID = Violation & {
  id: string;
};

export interface RuleSet {
  name?: string;
  description?: string;
  tags?: string[];
  violations?: { [key: string]: ViolationWithID };
  insights?: { [key: string]: ViolationWithID };
  errors?: { [key: string]: string };
  unmatched?: string[];
  skipped?: string[];
}

export interface GetSolutionParams {
  file_path: string;
  incidents: Incident[];
}
export interface Change {
  // relative file path before the change, may be empty if file was created in this change
  original: string;
  // relative file path after the change, may be empty if file was deleted in this change
  modified: string;
  // diff in unified format - tested with git diffs
  diff: string;
}

export interface GetSolutionResult {
  encountered_errors: string[];
  changes: Change[];
  scope: Scope;
}

export interface LocalChange {
  modifiedUri: Uri;
  originalUri: Uri;
  diff: string;
  state: "pending" | "applied" | "discarded";
}

export interface ResolutionMessage {
  type: string;
  solution: Solution;
  violation: Violation;
  incident: Incident;
  isRelevantSolution: boolean;
}

export interface SolutionResponse {
  diff: string;
  encountered_errors: string[];
  modified_files: string[];
}

export interface Scope {
  incidents: Incident[];
  violation?: Violation;
}

export type Solution = GetSolutionResult | SolutionResponse;

export interface ExtensionData {
  workspaceRoot: string;
  localChanges: LocalChange[];
  ruleSets: RuleSet[];
  resolutionPanelData: any;
  isAnalyzing: boolean;
  isFetchingSolution: boolean;
  isStartingServer: boolean;
  isInitializingServer: boolean;
  serverState: ServerState;
  solutionState: SolutionState;
  solutionData?: Solution;
  solutionScope?: Scope;
  solutionMessages: string[];
}

export type ServerState =
  | "initial"
  | "configurationNeeded"
  | "configurationReady"
  | "starting"
  | "readyToInitialize"
  | "initializing"
  | "startFailed"
  | "running"
  | "stopping"
  | "stopped";

export type SolutionState =
  | "none"
  | "started"
  | "sent"
  | "received"
  | "failedOnStart"
  | "failedOnSending";
