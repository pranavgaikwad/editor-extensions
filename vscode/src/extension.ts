import * as vscode from "vscode";
import { EventEmitter } from "events";
import { KonveyorGUIWebviewViewProvider } from "./KonveyorGUIWebviewViewProvider";
import { registerAllCommands as registerAllCommands } from "./commands";
import { ExtensionState } from "./extensionState";
import {
  ConfigError,
  createConfigError,
  ExtensionData,
  KONVEYOR_OUTPUT_CHANNEL_NAME,
} from "@editor-extensions/shared";
import { ViolationCodeActionProvider } from "./ViolationCodeActionProvider";
import { AnalyzerClient } from "./client/analyzerClient";
import {
  KaiInteractiveWorkflow,
  InMemoryCacheWithRevisions,
  SolutionServerClient,
  FileBasedResponseCache,
} from "@editor-extensions/agentic";
import { KonveyorFileModel, registerDiffView } from "./diffView";
import { MemFS } from "./data";
import { Immutable, produce } from "immer";
import { registerAnalysisTrigger } from "./analysis";
import { IssuesModel, registerIssueView } from "./issueView";
import { ExtensionPaths, ensurePaths, paths } from "./paths";
import { copySampleProviderSettings } from "./utilities/fileUtils";
import {
  getExcludedDiagnosticSources,
  getConfigSolutionServerEnabled,
  getConfigSolutionServerUrl,
  updateConfigErrors,
  getConfigAgentMode,
  getCacheDir,
  getTraceDir,
  getTraceEnabled,
  getConfigKaiDemoMode,
  getConfigLogLevel,
} from "./utilities";
import { getBundledProfiles } from "./utilities/profiles/bundledProfiles";
import { getUserProfiles } from "./utilities/profiles/profileService";
import { DiagnosticTaskManager } from "./taskManager/taskManager";
// Removed registerSuggestionCommands import since we're using merge editor now
// Removed InlineSuggestionCodeActionProvider import since we're using merge editor now
import { ParsedModelConfig } from "./modelProvider/types";
import { getModelProviderFromConfig, parseModelConfig } from "./modelProvider";
import winston from "winston";
import { OutputChannelTransport } from "winston-transport-vscode";

class VsCodeExtension {
  private state: ExtensionState;
  private data: Immutable<ExtensionData>;
  private _onDidChange = new vscode.EventEmitter<Immutable<ExtensionData>>();
  readonly onDidChangeData = this._onDidChange.event;
  private listeners: vscode.Disposable[] = [];

  constructor(
    public readonly paths: ExtensionPaths,
    public readonly context: vscode.ExtensionContext,
    logger: winston.Logger,
  ) {
    this.data = produce(
      {
        localChanges: [],
        ruleSets: [],
        enhancedIncidents: [],
        resolutionPanelData: undefined,
        isAnalyzing: false,
        isFetchingSolution: false,
        isStartingServer: false,
        isInitializingServer: false,
        isAnalysisScheduled: false,
        isContinueInstalled: false,
        solutionData: undefined,
        serverState: "initial",
        solutionScope: undefined,
        workspaceRoot: paths.workspaceRepo.toString(true),
        chatMessages: [],
        solutionState: "none",
        solutionServerEnabled: getConfigSolutionServerEnabled(),
        configErrors: [],
        activeProfileId: "",
        profiles: [],
        isAgentMode: getConfigAgentMode(),
        analysisConfig: {
          labelSelector: "",
          labelSelectorValid: false,
          providerConfigured: false,
          providerKeyMissing: false,
          customRulesConfigured: false,
        },
      } as ExtensionData,
      () => {},
    );
    const getData = () => this.data;
    const setData = (data: Immutable<ExtensionData>) => {
      this.data = data;
      this._onDidChange.fire(this.data);
    };
    const mutateData = (recipe: (draft: ExtensionData) => void): Immutable<ExtensionData> => {
      const data = produce(getData(), recipe);
      setData(data);
      return data;
    };

    const taskManager = new DiagnosticTaskManager(getExcludedDiagnosticSources());

    this.state = {
      analyzerClient: new AnalyzerClient(context, mutateData, getData, taskManager, logger),
      solutionServerClient: new SolutionServerClient(
        getConfigSolutionServerUrl(),
        getConfigSolutionServerEnabled(),
        logger,
      ),
      webviewProviders: new Map<string, KonveyorGUIWebviewViewProvider>(),
      extensionContext: context,
      diagnosticCollection: vscode.languages.createDiagnosticCollection("konveyor"),
      memFs: new MemFS(),
      fileModel: new KonveyorFileModel(),
      issueModel: new IssuesModel(),
      kaiFsCache: new InMemoryCacheWithRevisions(true),
      taskManager,
      logger,
      get data() {
        return getData();
      },
      mutateData,
      modifiedFiles: new Map(),
      modifiedFilesEventEmitter: new EventEmitter(),
      isWaitingForUserInteraction: false,
      lastMessageId: "0",
      currentTaskManagerIterations: 0,

      workflowManager: {
        workflow: undefined,
        isInitialized: false,
        init: async (config) => {
          if (this.state.workflowManager.isInitialized) {
            return;
          }

          try {
            this.state.workflowManager.workflow = new KaiInteractiveWorkflow(this.state.logger);
            // Make sure fsCache and solutionServerClient are passed to the workflow init
            await this.state.workflowManager.workflow.init({
              ...config,
              fsCache: this.state.kaiFsCache,
              solutionServerClient: this.state.solutionServerClient,
              toolCache: new FileBasedResponseCache(
                getConfigKaiDemoMode(), // cache enabled only when demo mode is on
                (args) =>
                  typeof args === "string" ? args : JSON.stringify(args, Object.keys(args).sort()),
                (args) => (typeof args === "string" ? args : JSON.parse(args)),
                getCacheDir(this.state.data.workspaceRoot),
                this.state.logger,
              ),
            });
            this.state.workflowManager.isInitialized = true;
          } catch (error) {
            console.error("Failed to initialize workflow:", error);
            // Reset state on initialization failure to avoid inconsistent state
            this.state.workflowManager.workflow = undefined;
            this.state.workflowManager.isInitialized = false;
            throw error; // Re-throw to let caller handle the error
          }
        },
        getWorkflow: () => {
          if (!this.state.workflowManager.workflow) {
            throw new Error("Workflow not initialized");
          }
          return this.state.workflowManager.workflow;
        },
        dispose: () => {
          try {
            // Clean up workflow resources if workflow exists
            if (this.state.workflowManager.workflow) {
              // Remove all event listeners to prevent memory leaks
              this.state.workflowManager.workflow.removeAllListeners();

              // Clear any pending user interactions
              const workflow = this.state.workflowManager.workflow as any;
              if (workflow.userInteractionPromises) {
                workflow.userInteractionPromises.clear();
              }
            }
          } catch (error) {
            console.error("Error during workflow cleanup:", error);
          } finally {
            // Always reset state regardless of cleanup success/failure
            this.state.workflowManager.workflow = undefined;
            this.state.workflowManager.isInitialized = false;
          }
        },
      },
      modelProvider: undefined,
    };
  }

  public async initialize(): Promise<void> {
    try {
      const bundled = getBundledProfiles();
      const user = getUserProfiles(this.context);
      const allProfiles = [...bundled, ...user];

      const storedActiveId = this.context.workspaceState.get<string>("activeProfileId");

      const matchingProfile = allProfiles.find((p) => p.id === storedActiveId);

      const activeProfileId =
        matchingProfile?.id ?? (allProfiles.length > 0 ? allProfiles[0].id : null);

      this.state.mutateData((draft) => {
        draft.profiles = allProfiles;
        draft.activeProfileId = activeProfileId;
        updateConfigErrors(draft, paths().settingsYaml.fsPath);
      });

      this.setupModelProvider(paths().settingsYaml)
        .then((configError) => {
          this.state.mutateData((draft) => {
            if (configError) {
              draft.configErrors.push(configError);
            }
          });
        })
        .catch((error) => {
          this.state.logger.error("Error setting up model provider:", error);
          this.state.mutateData((draft) => {
            if (error) {
              const configError = createConfigError.providerConnnectionFailed();
              configError.error = error instanceof Error ? error.message : String(error);
              draft.configErrors.push(configError);
            }
          });
        });

      this.registerWebviewProvider();
      this.listeners.push(this.onDidChangeData(registerDiffView(this.state)));
      this.listeners.push(this.onDidChangeData(registerIssueView(this.state)));
      this.registerCommands();
      this.registerLanguageProviders();
      this.checkContinueInstalled();
      this.state.solutionServerClient.connect().catch((error) => {
        this.state.logger.error("Error connecting to solution server", error);
      });
      this.checkJavaExtensionInstalled();

      // Listen for extension changes to update Continue installation status and Java extension status
      this.listeners.push(
        vscode.extensions.onDidChange(() => {
          this.checkContinueInstalled();
          this.checkJavaExtensionInstalled();
        }),
      );

      // Listen for workspace folder changes to update workspace configuration errors
      this.listeners.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
          this.state.logger.info("Workspace folders changed!");
          vscode.window
            .showInformationMessage(
              "Workspace folders have changed. Please restart the Konveyor extension for changes to take effect.",
              "Restart Now",
            )
            .then((selection) => {
              if (selection === "Restart Now") {
                vscode.commands.executeCommand("workbench.action.reloadWindow");
              }
            });
        }),
      );

      registerAnalysisTrigger(this.listeners, this.state);

      // Removed decorator-related editor change listener since we're using merge editor now

      this.listeners.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
          if (doc.uri.fsPath === paths().settingsYaml.fsPath) {
            const configError = await this.setupModelProvider(paths().settingsYaml);
            this.state.mutateData((draft) => {
              draft.configErrors = [];
              if (configError) {
                draft.configErrors.push(configError);
              }
              updateConfigErrors(draft, paths().settingsYaml.fsPath);
            });
          }
        }),
      );

      this.listeners.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
          this.state.logger.info("Configuration modified!");

          if (
            event.affectsConfiguration("konveyor.kai.demoMode") ||
            event.affectsConfiguration("konveyor.kai.cacheDir")
          ) {
            this.setupModelProvider(paths().settingsYaml)
              .then((configError) => {
                this.state.mutateData((draft) => {
                  if (configError) {
                    draft.configErrors = draft.configErrors.filter(
                      (e) => e.type !== configError.type,
                    );
                    draft.configErrors.push(configError);
                  }
                });
              })
              .catch((error) => {
                this.state.logger.error("Error setting up model provider:", error);
                this.state.mutateData((draft) => {
                  if (error) {
                    const configError = createConfigError.providerConnnectionFailed();
                    draft.configErrors = draft.configErrors.filter(
                      (e) => e.type !== configError.type,
                    );
                    configError.error = error instanceof Error ? error.message : String(error);
                    draft.configErrors.push(configError);
                  }
                });
              });
          }

          if (event.affectsConfiguration("konveyor.kai.agentMode")) {
            const agentMode = getConfigAgentMode();
            this.state.mutateData((draft) => {
              draft.isAgentMode = agentMode;
            });
          }

          if (
            event.affectsConfiguration("konveyor.solutionServer.url") ||
            event.affectsConfiguration("konveyor.solutionServer.enabled")
          ) {
            this.state.logger.info("Solution server configuration modified!");
            vscode.window
              .showInformationMessage(
                "Solution server configuration has changed. Please restart the Konveyor extension for changes to take effect.",
                "Restart Now",
              )
              .then((selection) => {
                if (selection === "Restart Now") {
                  vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
              });
          }
        }),
      );

      vscode.commands.executeCommand("konveyor.loadResultsFromDataFolder");
      this.state.logger.info("Extension initialized");
    } catch (error) {
      this.state.logger.error("Error initializing extension", error);
      vscode.window.showErrorMessage(`Failed to initialize Konveyor extension: ${error}`);
    }
  }

  private registerWebviewProvider(): void {
    const sidebarProvider = new KonveyorGUIWebviewViewProvider(this.state, "sidebar");
    const resolutionViewProvider = new KonveyorGUIWebviewViewProvider(this.state, "resolution");
    const profilesViewProvider = new KonveyorGUIWebviewViewProvider(this.state, "profiles");

    this.state.webviewProviders.set("sidebar", sidebarProvider);
    this.state.webviewProviders.set("resolution", resolutionViewProvider);
    this.state.webviewProviders.set("profiles", profilesViewProvider);

    [sidebarProvider, resolutionViewProvider, profilesViewProvider].forEach((provider) =>
      this.onDidChangeData((data) => {
        provider.sendMessageToWebview(data);
      }),
    );

    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        KonveyorGUIWebviewViewProvider.SIDEBAR_VIEW_TYPE,
        sidebarProvider,
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
      vscode.window.registerWebviewViewProvider(
        KonveyorGUIWebviewViewProvider.RESOLUTION_VIEW_TYPE,
        resolutionViewProvider,
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
      vscode.window.registerWebviewViewProvider(
        KonveyorGUIWebviewViewProvider.PROFILES_VIEW_TYPE,
        profilesViewProvider,
        {
          webviewOptions: { retainContextWhenHidden: true },
        },
      ),
    );
  }

  private registerCommands(): void {
    try {
      registerAllCommands(this.state);
      // Removed registerSuggestionCommands since we're using merge editor now
    } catch (error) {
      this.state.logger.error("Critical error during command registration", error);
      vscode.window.showErrorMessage(
        `Konveyor extension failed to register commands properly. The extension may not function correctly. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Re-throw to indicate the extension is not in a good state
      throw error;
    }
  }

  private registerLanguageProviders(): void {
    const documentSelectors: vscode.DocumentSelector = [
      // Language IDs
      "java",
      "yaml",
      "properties",
      "groovy", // for Gradle files
      // Specific file patterns
      { pattern: "**/pom.xml" },
      { pattern: "**/build.gradle" },
      { pattern: "**/build.gradle.kts" },
    ];

    this.context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        documentSelectors,
        new ViolationCodeActionProvider(this.state),
        {
          providedCodeActionKinds: ViolationCodeActionProvider.providedCodeActionKinds,
        },
      ),
    );
  }

  private checkContinueInstalled(): void {
    const continueExt = vscode.extensions.getExtension("Continue.continue");
    this.state.mutateData((draft) => {
      draft.isContinueInstalled = !!continueExt;
    });
  }

  private checkJavaExtensionInstalled(): void {
    const javaExt = vscode.extensions.getExtension("redhat.java");
    if (!javaExt) {
      vscode.window
        .showWarningMessage(
          "The Red Hat Java Language Support extension is required for proper Java analysis. " +
            "Please install it from the VS Code marketplace.",
          "Install Java Extension",
        )
        .then((selection) => {
          if (selection === "Install Java Extension") {
            vscode.commands.executeCommand("workbench.extensions.search", "redhat.java");
          }
        });
      return;
    }

    if (!javaExt.isActive) {
      vscode.window.showInformationMessage(
        "The Java Language Support extension is installed but not yet active. " +
          "Java analysis features may be limited until it's fully loaded.",
      );
    }
  }

  private async setupModelProvider(settingsPath: vscode.Uri): Promise<ConfigError | undefined> {
    let modelConfig: ParsedModelConfig;
    try {
      modelConfig = await parseModelConfig(settingsPath);
    } catch (err) {
      this.state.logger.error("Error getting model config:", err);
      const configError = createConfigError.providerNotConfigured();
      configError.error = err instanceof Error ? err.message : String(err);
      return configError;
    }
    try {
      this.state.modelProvider = await getModelProviderFromConfig(
        modelConfig,
        this.state.logger,
        getConfigKaiDemoMode() ? getCacheDir(this.data.workspaceRoot) : undefined,
        getTraceEnabled() ? getTraceDir(this.data.workspaceRoot) : undefined,
      );
    } catch (err) {
      this.state.logger.error("Error running model health check:", err);
      const configError = createConfigError.providerConnnectionFailed();
      configError.error =
        err instanceof Error
          ? err.message.length > 150
            ? err.message.slice(0, 150) + "..."
            : err.message
          : String(err);
      return configError;
    }
    return undefined;
  }

  public async dispose() {
    // Clean up pending interactions and resolver function to prevent memory leaks
    this.state.resolvePendingInteraction = undefined;
    this.state.isWaitingForUserInteraction = false;

    // Dispose workflow manager
    if (this.state.workflowManager && this.state.workflowManager.dispose) {
      try {
        this.state.workflowManager.dispose();
      } catch (error) {
        this.state.logger.error("Error disposing workflow manager:", error);
      }
    }

    await this.state.analyzerClient?.stop();
    await this.state.solutionServerClient?.disconnect().catch((error) => {
      this.state.logger.error("Error disconnecting from solution server", error);
    });
    const disposables = this.listeners.splice(0, this.listeners.length);
    for (const disposable of disposables) {
      disposable.dispose();
    }
  }
}

let extension: VsCodeExtension | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Logger is our bae...before anything else
  const outputChannel = vscode.window.createOutputChannel(KONVEYOR_OUTPUT_CHANNEL_NAME);
  const logger = winston.createLogger({
    level: getConfigLogLevel(),
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
    transports: [
      new winston.transports.File({
        filename: vscode.Uri.joinPath(context.logUri, "extension.log").fsPath,
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 3,
      }),
      new OutputChannelTransport({
        outputChannel,
      }),
    ],
  });

  logger.info("Logger created");

  try {
    const paths = await ensurePaths(context, logger);
    await copySampleProviderSettings();

    extension = new VsCodeExtension(paths, context, logger);
    await extension.initialize();
  } catch (error) {
    await extension?.dispose();
    extension = undefined;
    logger.error("Failed to activate Konveyor extension", error);
    vscode.window.showErrorMessage(`Failed to activate Konveyor extension: ${error}`);
    throw error; // Re-throw to ensure VS Code marks the extension as failed to activate
  }
}

export async function deactivate(): Promise<void> {
  // Removed decorator disposal since we're using merge editor now
  await extension?.dispose();
}
