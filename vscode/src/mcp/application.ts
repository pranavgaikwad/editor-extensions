import { Server } from "http";
import winston from "winston";
import { randomUUID } from "crypto";
import express, { Application, Request, Response, NextFunction } from "express";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { AnalysisMcpServer } from "./mcp";
import { ExtensionState } from "../extensionState";

export interface AnalysisApplicationConfig {
  port?: number;
  host?: string;
  enableCors?: boolean;
  requestTimeout?: number;
}

export interface AnalysisSession {
  // taskManager
  transport: StreamableHTTPServerTransport;
}

export class AnalysisApplication {
  private app: Application;
  private server: Server | null = null;
  private logger: winston.Logger;
  private config: Required<AnalysisApplicationConfig>;
  private isShuttingDown = false;
  private sessions: Map<string, AnalysisSession>;

  constructor(config: AnalysisApplicationConfig = {}, logger?: winston.Logger) {
    this.config = {
      port: config.port ?? 3000,
      host: config.host ?? "localhost",
      enableCors: config.enableCors ?? false,
      requestTimeout: config.requestTimeout ?? 1200000,
    };

    this.logger =
      logger ??
      winston.createLogger({
        level: "info",
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
        transports: [new winston.transports.Console()],
      });

    this.sessions = new Map<string, AnalysisSession>();
    this.app = express();
    this.setupMiddleware();
    this.setupErrorHandling();
  }

  public async initMcp(state: ExtensionState, workspaceDir: string): Promise<void> {
    this.app.post("/mcp", async (req: Request, res: Response) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId);
        transport = (session as AnalysisSession).transport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            this.sessions.set(sessionId, {
              transport,
            });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            this.sessions.delete(transport.sessionId);
          }
        };
        const analysisMcpServer = new AnalysisMcpServer(state, workspaceDir);
        await analysisMcpServer.initialize(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    });
  }

  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.port, this.config.host, () => {
          this.logger.info(`Analysis server started on ${this.config.host}:${this.config.port}`);
          resolve();
        });
        this.server!.timeout = this.config.requestTimeout;
        this.server!.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EADDRINUSE") {
            this.logger.error(`Port ${this.config.port} is already in use`);
            reject(new Error(`Port ${this.config.port} is already in use`));
          } else {
            this.logger.error("Server error:", error);
            reject(error);
          }
        });
        process.on("SIGTERM", () => this.gracefulShutdown("SIGTERM"));
        process.on("SIGINT", () => this.gracefulShutdown("SIGINT"));
      } catch (error) {
        this.logger.error("Failed to start analysis server:", error);
        reject(error);
      }
    });
  }

  public async stop(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;
    this.logger.info("Stopping analysis server...");
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => {
        if (error) {
          this.logger.error("Error during server shutdown:", error);
        } else {
          this.logger.info("Analysis server stopped successfully");
        }
        this.server = null;
        resolve();
      });
    });
  }

  private setupMiddleware(): void {
    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      res.on("finish", () => {
        const duration = Date.now() - start;
        this.logger.info(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
      });
      next();
    });

    if (this.config.enableCors) {
      this.app.use((req: Request, res: Response, next: NextFunction) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
        res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

        if (req.method === "OPTIONS") {
          res.sendStatus(200);
          return;
        }
        next();
      });
    }
  }

  private setupErrorHandling(): void {
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: "Not Found",
        message: `Route ${req.method} ${req.path} not found`,
        timestamp: new Date().toISOString(),
      });
    });
    this.app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
      this.logger.error("Unhandled error:", {
        error: error.message,
        stack: error.stack,
        path: req.path,
        method: req.method,
      });

      if (res.headersSent) {
        return next(error);
      }

      res.status(500).json({
        error: "Internal Server Error",
        message: process.env.NODE_ENV === "development" ? error.message : "Something went wrong",
        timestamp: new Date().toISOString(),
      });
    });
  }

  private async gracefulShutdown(signal: string): Promise<void> {
    this.logger.info(`Received ${signal}, initiating graceful shutdown...`);
    try {
      await this.stop();
      process.exit(0);
    } catch (error) {
      this.logger.error("Error during graceful shutdown:", error);
      process.exit(1);
    }
  }
}
