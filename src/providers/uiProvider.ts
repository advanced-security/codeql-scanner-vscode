import * as vscode from "vscode";
import * as path from "path";
import { ResultsProvider } from "./resultsProvider";
import { ScanResult, CodeQLService } from "../services/codeqlService";
import { GitHubService } from "../services/githubService";
import { LoggerService } from "../services/loggerService";

export class UiProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codeql-scanner.config";

  private _view?: vscode.WebviewView;
  private _scanResults: ScanResult[] = [];
  private _resultsProvider?: ResultsProvider;
  private _githubService: GitHubService;
  private _codeqlService?: CodeQLService;
  private logger: LoggerService;
  private _scanStartTime?: number;
  private _fetchStartTime?: number;

  constructor(private readonly _extensionContext: vscode.ExtensionContext) {
    this._githubService = new GitHubService();
    this.logger = LoggerService.getInstance();
  }

  public setResultsProvider(resultsProvider: ResultsProvider): void {
    this._resultsProvider = resultsProvider;
  }

  public setCodeQLService(codeqlService: CodeQLService): void {
    this._codeqlService = codeqlService;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionContext.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case "saveConfig":
            this.saveConfiguration(message.config);
            break;
          case "loadConfig":
            this.loadConfiguration();
            break;
          case "testConnection":
            this.testGitHubConnection();
            break;
          case "runLocalScan":
            this.runLocalScan();
            break;
          case "loadAlertsSummary":
            this.loadAlertsSummary();
            break;
          case "fetchRemoteAlerts":
            this.fetchRemoteAlerts();
            break;
          case "loadSupportedLanguages":
            this.loadSupportedLanguages();
            break;
        }
      },
      undefined,
      this._extensionContext.subscriptions
    );

    // Load initial configuration
    this.loadConfiguration();

    // Auto-load supported languages on startup
    this.autoLoadLanguagesIfNeeded();
  }

  private async saveConfiguration(config: any) {
    this.logger.logServiceCall("UiProvider", "saveConfiguration", "started");
    const workspaceConfig = vscode.workspace.getConfiguration("codeql-scanner");

    try {
      await Promise.all([
        workspaceConfig.update(
          "github.token",
          config.githubToken,
          vscode.ConfigurationTarget.Global
        ),
        workspaceConfig.update(
          "github.owner",
          config.githubOwner,
          vscode.ConfigurationTarget.Workspace
        ),
        workspaceConfig.update(
          "github.repo",
          config.githubRepo,
          vscode.ConfigurationTarget.Workspace
        ),
        workspaceConfig.update(
          "suites",
          config.suites,
          vscode.ConfigurationTarget.Workspace
        ),
        workspaceConfig.update(
          "languages",
          config.languages,
          vscode.ConfigurationTarget.Workspace
        ),
        workspaceConfig.update(
          "codeqlPath",
          config.codeqlPath,
          vscode.ConfigurationTarget.Global
        ),
        workspaceConfig.update(
          "threatModel",
          config.threatModel,
          vscode.ConfigurationTarget.Workspace
        ),
      ]);

      this.logger.logServiceCall(
        "UiProvider",
        "saveConfiguration",
        "completed"
      );
      this.logger.logConfiguration("UiProvider", {
        ...config,
        githubToken: "[REDACTED]",
      });

      this._view?.webview.postMessage({
        command: "configSaved",
        success: true,
        message: "Configuration saved successfully!",
      });

      vscode.window.showInformationMessage(
        "CodeQL Scanner configuration saved!"
      );
    } catch (error) {
      this.logger.logServiceCall(
        "UiProvider",
        "saveConfiguration",
        "failed",
        error
      );
      this._view?.webview.postMessage({
        command: "configSaved",
        success: false,
        message: `Failed to save configuration: ${error}`,
      });
    }
  }

  private async loadConfiguration() {
    const config = vscode.workspace.getConfiguration("codeql-scanner");

    // Check if threatModel is set, if not automatically set it to "Remote"
    let threatModel = config.get<string>("threatModel");
    if (!threatModel) {
      threatModel = "Remote";
      // Automatically save the default threat model to configuration
      await config.update(
        "threatModel",
        threatModel,
        vscode.ConfigurationTarget.Workspace
      );
      this.logger.info(
        "UiProvider",
        "Automatically set threat model to 'Remote' as default"
      );
    }

    const configuration = {
      githubToken: config.get<string>("github.token", ""),
      githubOwner: config.get<string>("github.owner", ""),
      githubRepo: config.get<string>("github.repo", ""),
      suites: config.get<string[]>("suites", ["code-scanning"]),
      languages: config.get<string[]>("languages", []),
      codeqlPath: config.get<string>("codeqlPath", "codeql"),
      threatModel: threatModel,
    };

    this._view?.webview.postMessage({
      command: "configLoaded",
      config: configuration,
    });
  }

  private async testGitHubConnection() {
    this.logger.logServiceCall("UiProvider", "testGitHubConnection", "started");
    const config = vscode.workspace.getConfiguration("codeql-scanner");
    const token = config.get<string>("github.token");

    if (!token) {
      this.logger.warn(
        "UiProvider",
        "GitHub connection test failed: no token configured"
      );
      this._view?.webview.postMessage({
        command: "connectionTest",
        success: false,
        message: "GitHub token is required",
      });
      return;
    }

    try {
      // Update the service with the current token
      this._githubService.updateToken(token);

      // Test the connection by getting repository info
      await this._githubService.getRepositoryInfo();

      this.logger.logServiceCall(
        "UiProvider",
        "testGitHubConnection",
        "completed"
      );
      this._view?.webview.postMessage({
        command: "connectionTest",
        success: true,
        message: "GitHub connection successful!",
      });
    } catch (error) {
      this.logger.logServiceCall(
        "UiProvider",
        "testGitHubConnection",
        "failed",
        error
      );
      this._view?.webview.postMessage({
        command: "connectionTest",
        success: false,
        message: `GitHub connection failed: ${error}`,
      });
    }
  }

  private async loadSupportedLanguages() {
    this.logger.logServiceCall(
      "UiProvider",
      "loadSupportedLanguages",
      "started"
    );

    if (!this._codeqlService) {
      this.logger.warn(
        "UiProvider",
        "CodeQL service not available for loading supported languages"
      );
      this._view?.webview.postMessage({
        command: "supportedLanguagesLoaded",
        success: false,
        languages: [],
        message: "CodeQL service not available",
      });
      return;
    }

    try {
      await this._codeqlService.getSupportedLanguages();
      let supportedLanguages = this._codeqlService.getLanguages();
      // Filter out unwanted languages
      const excluded = ["html", "xml", "yaml", "csv", "properties"];
      supportedLanguages = supportedLanguages.filter(
        (lang) => !excluded.includes(lang.toLowerCase())
      );

      this.logger.logServiceCall(
        "UiProvider",
        "loadSupportedLanguages",
        "completed",
        { languageCount: supportedLanguages.length }
      );

      this._view?.webview.postMessage({
        command: "supportedLanguagesLoaded",
        success: true,
        languages: supportedLanguages,
        message: `Found ${supportedLanguages.length} supported languages`,
      });
    } catch (error) {
      this.logger.logServiceCall(
        "UiProvider",
        "loadSupportedLanguages",
        "failed",
        error
      );
      this._view?.webview.postMessage({
        command: "supportedLanguagesLoaded",
        success: false,
        languages: [],
        message: `Failed to load supported languages: ${error}`,
      });
    }
  }

  private async autoLoadLanguagesIfNeeded() {
    this.logger.logServiceCall(
      "UiProvider",
      "autoLoadLanguagesIfNeeded",
      "started"
    );

    try {
      // Check if languages are already configured
      const config = vscode.workspace.getConfiguration("codeql-scanner");
      const configuredLanguages = config.get<string[]>("languages", []);

      if (configuredLanguages.length > 0) {
        this.logger.debug(
          "UiProvider",
          `Languages already configured: ${configuredLanguages.join(", ")}`
        );
        return;
      }

      // If no CodeQL service is available, can't auto-load
      if (!this._codeqlService) {
        this.logger.debug(
          "UiProvider",
          "CodeQL service not available for auto-loading languages"
        );
        return;
      }

      this.logger.info(
        "UiProvider",
        "No languages configured, attempting to auto-load supported languages"
      );

      // Try to get supported languages from CodeQL CLI
      await this._codeqlService.getSupportedLanguages();
      const supportedLanguages = this._codeqlService.getLanguages();

      if (supportedLanguages.length > 0) {
        this.logger.info(
          "UiProvider",
          `Auto-loaded ${
            supportedLanguages.length
          } supported languages: ${supportedLanguages.join(", ")}`
        );

        // Send the languages to the webview for display
        this._view?.webview.postMessage({
          command: "supportedLanguagesLoaded",
          success: true,
          languages: supportedLanguages,
          message: `Auto-loaded ${supportedLanguages.length} supported languages`,
        });

        this.logger.logServiceCall(
          "UiProvider",
          "autoLoadLanguagesIfNeeded",
          "completed",
          { languageCount: supportedLanguages.length }
        );
      } else {
        this.logger.warn(
          "UiProvider",
          "No supported languages found during auto-load"
        );
      }
    } catch (error) {
      this.logger.warn("UiProvider", "Failed to auto-load languages", error);
      // Don't show error to user for auto-loading, just log it
    }
  }

  private async runLocalScan() {
    try {
      this._scanStartTime = Date.now();

      this._view?.webview.postMessage({
        command: "scanStarted",
        success: true,
        message: "Starting local CodeQL scan...",
      });

      // Trigger the scan command
      await vscode.commands.executeCommand("codeql-scanner.scan");

      const scanDuration = this._scanStartTime
        ? Date.now() - this._scanStartTime
        : 0;
      const durationText = this.formatDuration(scanDuration);

      this._view?.webview.postMessage({
        command: "scanCompleted",
        success: true,
        message: `CodeQL scan completed successfully in ${durationText}!`,
        duration: scanDuration,
      });
    } catch (error) {
      const scanDuration = this._scanStartTime
        ? Date.now() - this._scanStartTime
        : 0;
      const durationText = this.formatDuration(scanDuration);

      this._view?.webview.postMessage({
        command: "scanCompleted",
        success: false,
        message: `CodeQL scan failed after ${durationText}: ${error}`,
        duration: scanDuration,
      });
    }
  }

  private async fetchRemoteAlerts() {
    try {
      this._fetchStartTime = Date.now();

      this._view?.webview.postMessage({
        command: "fetchStarted",
        success: true,
        message: "Fetching remote security alerts...",
      });

      const config = vscode.workspace.getConfiguration("codeql-scanner");
      const token = config.get<string>("github.token");
      const owner = config.get<string>("github.owner");
      const repo = config.get<string>("github.repo");

      if (!token || !owner || !repo) {
        throw new Error(
          "GitHub configuration is incomplete. Please configure token, owner, and repo."
        );
      }

      // Update the service with the current token
      this._githubService.updateToken(token);

      // Use GitHubService to fetch CodeQL alerts
      const codeqlAlerts = await this._githubService.getCodeQLAlerts(
        owner,
        repo
      );

      // Convert GitHub alerts to our ScanResult format
      const scanResults = codeqlAlerts.map((alert: any) => ({
        ruleId: alert.rule?.id || "unknown",
        severity: this.mapGitHubSeverityToLocal(alert.rule?.severity),
        message:
          alert.message?.text || alert.rule?.description || "No description",
        location: {
          file: alert.most_recent_instance?.location?.path || "unknown",
          startLine: alert.most_recent_instance?.location?.start_line || 1,
          startColumn: alert.most_recent_instance?.location?.start_column || 1,
          endLine: alert.most_recent_instance?.location?.end_line || 1,
          endColumn: alert.most_recent_instance?.location?.end_column || 1,
        },
      }));

      // Update the scan results and refresh summary
      this.updateScanResults(scanResults);

      // Also update the results provider if available
      if (this._resultsProvider) {
        this._resultsProvider.setResults(scanResults);
        vscode.commands.executeCommand(
          "setContext",
          "codeql-scanner.hasResults",
          scanResults.length > 0
        );
      }

      const fetchDuration = this._fetchStartTime
        ? Date.now() - this._fetchStartTime
        : 0;
      const durationText = this.formatDuration(fetchDuration);

      this._view?.webview.postMessage({
        command: "fetchCompleted",
        success: true,
        message: `Fetched ${scanResults.length} CodeQL security alerts from GitHub in ${durationText}`,
        duration: fetchDuration,
      });
    } catch (error) {
      const fetchDuration = this._fetchStartTime
        ? Date.now() - this._fetchStartTime
        : 0;
      const durationText = this.formatDuration(fetchDuration);

      this._view?.webview.postMessage({
        command: "fetchCompleted",
        success: false,
        message: `Failed to fetch remote alerts after ${durationText}: ${error}`,
        duration: fetchDuration,
      });
    }
  }

  private mapGitHubSeverityToLocal(severity?: string): string {
    if (!severity) return "medium";

    switch (severity.toLowerCase()) {
      case "critical":
        return "critical";
      case "high":
        return "high";
      case "medium":
      case "moderate":
        return "medium";
      case "low":
      case "note":
      case "info":
        return "low";
      default:
        return "medium";
    }
  }

  public updateScanResults(results: ScanResult[]): void {
    this._scanResults = results;
    this.loadAlertsSummary();
  }

  private async loadAlertsSummary() {
    // If no scan results are stored locally, try to get them from results provider
    let resultsToUse = this._scanResults;
    if (resultsToUse.length === 0 && this._resultsProvider) {
      try {
        resultsToUse = this._resultsProvider.getResults();
      } catch (error) {
        this.logger.debug("UiProvider", "No previous scan results available");
        resultsToUse = [];
      }
    }

    const summary = this.generateAlertsSummary(resultsToUse);

    this._view?.webview.postMessage({
      command: "alertsSummaryLoaded",
      summary: summary,
    });
  }

  private generateAlertsSummary(results: ScanResult[]): any {
    if (!results || results.length === 0) {
      return {
        total: 0,
        severityBreakdown: { critical: 0, high: 0, medium: 0, low: 0 },
        topRules: [],
        topFiles: [],
        scanDate: null,
      };
    }

    // Group by severity
    const severityBreakdown: { [key: string]: number } = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    results.forEach((result) => {
      const severity = result.severity || "medium";
      if (severityBreakdown[severity] !== undefined) {
        severityBreakdown[severity]++;
      } else {
        severityBreakdown[severity] = 1;
      }
    });

    // Get top rules
    const ruleCount: { [key: string]: number } = {};
    results.forEach((result) => {
      const ruleId = result.ruleId || "unknown";
      ruleCount[ruleId] = (ruleCount[ruleId] || 0) + 1;
    });

    const topRules = Object.entries(ruleCount)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 5)
      .map(([rule, count]) => ({ rule, count }));

    // Get top files
    const fileCount: { [key: string]: number } = {};
    results.forEach((result) => {
      const fileName = result.location?.file
        ? result.location.file.split("/").pop() || "unknown"
        : "unknown";
      fileCount[fileName] = (fileCount[fileName] || 0) + 1;
    });

    const topFiles = Object.entries(fileCount)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 5)
      .map(([file, count]) => ({ file, count }));

    return {
      total: results.length,
      severityBreakdown: {
        critical: severityBreakdown.critical || 0,
        high: severityBreakdown.high || 0,
        medium: severityBreakdown.medium || 0,
        low: severityBreakdown.low || 0,
      },
      topRules,
      topFiles,
      scanDate: new Date().toISOString(),
    };
  }

  private formatDuration(milliseconds: number): string {
    if (milliseconds < 1000) {
      return `${milliseconds}ms`;
    }

    const seconds = Math.floor(milliseconds / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
      return remainingSeconds > 0
        ? `${minutes}m ${remainingSeconds}s`
        : `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`;
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodeQL Scanner Configuration</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 20px;
        }
        
        .form-group {
            margin-bottom: 15px;
        }
        
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
            color: var(--vscode-input-foreground);
        }
        
        input, textarea, select {
            width: 100%;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            box-sizing: border-box;
        }
        
        input:focus, textarea:focus, select:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 15px;
            border-radius: 3px;
            cursor: pointer;
            margin-right: 10px;
            margin-bottom: 10px;
        }
        
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        
        #scanButton {
            background-color: var(--vscode-button-secondaryBackground, #0e639c);
            color: var(--vscode-button-secondaryForeground, white);
            font-weight: bold;
        }
        
        #scanButton:hover:not(:disabled) {
            background-color: var(--vscode-button-secondaryHoverBackground, #1177bb);
        }
        
        #fetchButton {
            background-color: var(--vscode-button-secondaryBackground, #228b22);
            color: var(--vscode-button-secondaryForeground, white);
            font-weight: bold;
        }
        
        #fetchButton:hover:not(:disabled) {
            background-color: var(--vscode-button-secondaryHoverBackground, #32cd32);
        }
        
        .success {
            color: var(--vscode-terminal-ansiGreen);
        }
        
        .error {
            color: var(--vscode-errorForeground);
        }
        
        .array-input {
            min-height: 60px;
        }
        
        .help-text {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            margin-top: 3px;
        }
        
        .section {
            margin-bottom: 25px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .section:last-child {
            border-bottom: none;
        }
        
        h3 {
            margin-top: 0;
            color: var(--vscode-foreground);
        }
        
        #message {
            margin-top: 15px;
            padding: 10px;
            border-radius: 3px;
            display: none;
        }
        
        .summary-section {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            padding: 15px;
            margin-bottom: 20px;
        }
        
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 15px;
        }
        
        .summary-card {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 15px 12px;
            text-align: center;
            transition: all 0.2s ease;
            position: relative;
            overflow: hidden;
        }
        
        .summary-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }
        
        .summary-card.critical {
            background: linear-gradient(135deg, rgba(255, 67, 67, 0.08) 0%, rgba(255, 67, 67, 0.12) 100%);
            border-color: rgba(255, 67, 67, 0.4);
        }
        
        .summary-card.critical:hover {
            background: linear-gradient(135deg, rgba(255, 67, 67, 0.12) 0%, rgba(255, 67, 67, 0.18) 100%);
            border-color: rgba(255, 67, 67, 0.6);
        }
        
        .summary-card.high {
            background: linear-gradient(135deg, rgba(255, 87, 34, 0.08) 0%, rgba(255, 87, 34, 0.12) 100%);
            border-color: rgba(255, 87, 34, 0.4);
        }
        
        .summary-card.high:hover {
            background: linear-gradient(135deg, rgba(255, 87, 34, 0.12) 0%, rgba(255, 87, 34, 0.18) 100%);
            border-color: rgba(255, 87, 34, 0.6);
        }
        
        .summary-card.medium {
            background: linear-gradient(135deg, rgba(255, 193, 7, 0.08) 0%, rgba(255, 193, 7, 0.12) 100%);
            border-color: rgba(255, 193, 7, 0.4);
        }
        
        .summary-card.medium:hover {
            background: linear-gradient(135deg, rgba(255, 193, 7, 0.12) 0%, rgba(255, 193, 7, 0.18) 100%);
            border-color: rgba(255, 193, 7, 0.6);
        }
        
        .summary-card.low {
            background: linear-gradient(135deg, rgba(33, 150, 243, 0.08) 0%, rgba(33, 150, 243, 0.12) 100%);
            border-color: rgba(33, 150, 243, 0.4);
        }
        
        .summary-card.low:hover {
            background: linear-gradient(135deg, rgba(33, 150, 243, 0.12) 0%, rgba(33, 150, 243, 0.18) 100%);
            border-color: rgba(33, 150, 243, 0.6);
        }
        
        .summary-number {
            font-size: 28px;
            font-weight: bold;
            color: var(--vscode-foreground);
            margin-bottom: 4px;
            display: block;
        }
        
        .summary-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 5px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .severity-critical { 
            color: #ff4343 !important; 
            font-weight: bold; 
            text-shadow: 0 0 3px rgba(255, 67, 67, 0.3);
            position: relative;
        }
        
        .severity-critical::before {
            content: "🔥";
            position: absolute;
            top: -2px;
            right: -20px;
            font-size: 14px;
            opacity: 0.6;
        }
        
        .severity-high { 
            color: #ff5722 !important; 
            font-weight: bold;
            position: relative;
        }
        
        .severity-high::before {
            content: "⚠️";
            position: absolute;
            top: -2px;
            right: -20px;
            font-size: 14px;
            opacity: 0.6;
        }
        
        .severity-medium { 
            color: #ffc107 !important; 
            font-weight: 600;
            position: relative;
        }
        
        .severity-medium::before {
            content: "⚡";
            position: absolute;
            top: -2px;
            right: -20px;
            font-size: 14px;
            opacity: 0.6;
        }
        
        .severity-low { 
            color: #2196f3 !important; 
            font-weight: 500;
            position: relative;
        }
        
        .severity-low::before {
            content: "ℹ️";
            position: absolute;
            top: -2px;
            right: -20px;
            font-size: 14px;
            opacity: 0.6;
        }
        
        .top-items {
            margin-top: 20px;
        }
        
        .top-items h4 {
            margin: 0 0 12px 0;
            font-size: 14px;
            color: var(--vscode-foreground);
            font-weight: 600;
        }
        
        .top-list {
            list-style: none;
            padding: 0;
            margin: 0;
            background-color: var(--vscode-input-background);
            border-radius: 4px;
            border: 1px solid var(--vscode-input-border);
            overflow: hidden;
        }
        
        .top-list li {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px;
            transition: background-color 0.15s ease;
        }
        
        .top-list li:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .top-list li:last-child {
            border-bottom: none;
        }
        
        .top-list li .count {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            min-width: 20px;
            text-align: center;
        }
        
        .no-results {
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            padding: 20px;
        }
        
        .timer-display {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            margin-left: 10px;
            font-family: monospace;
        }
        
        .scan-section {
            position: relative;
        }

        .language-checkbox {
            display: flex;
            align-items: center;
            margin-bottom: 8px;
            padding: 8px;
            border-radius: 4px;
            transition: background-color 0.15s ease;
        }

        .language-checkbox:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .language-checkbox input[type="checkbox"] {
            width: auto;
            margin-right: 10px;
            margin-bottom: 0;
        }

        .language-checkbox label {
            margin-bottom: 0;
            font-weight: normal;
            cursor: pointer;
            flex: 1;
            text-transform: capitalize;
        }

        .language-icon {
            width: 16px;
            height: 16px;
            margin-right: 8px;
            border-radius: 2px;
            display: inline-block;
            font-size: 12px;
            text-align: center;
            line-height: 16px;
        }

        .language-javascript { background-color: #f7df1e; color: #000; }
        .language-typescript { background-color: #3178c6; color: #fff; }
        .language-python { background-color: #3776ab; color: #fff; }
        .language-java { background-color: #ed8b00; color: #fff; }
        .language-csharp { background-color: #239120; color: #fff; }
        .language-cpp { background-color: #00599c; color: #fff; }
        .language-go { background-color: #00add8; color: #fff; }
        .language-ruby { background-color: #cc342d; color: #fff; }
        .language-default { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); }

        .suite-radio {
            display: flex;
            align-items: flex-start;
            margin-bottom: 12px;
            padding: 12px;
            border-radius: 6px;
            border: 1px solid var(--vscode-input-border);
            transition: all 0.15s ease;
            cursor: pointer;
        }

        .suite-radio:hover {
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .suite-radio input[type="radio"] {
            width: auto;
            margin-right: 12px;
            margin-top: 2px;
            cursor: pointer;
        }

        .suite-radio label {
            margin-bottom: 0;
            font-weight: normal;
            cursor: pointer;
            flex: 1;
            display: flex;
            flex-direction: column;
        }

        .suite-name {
            font-weight: 600;
            color: var(--vscode-foreground);
            margin-bottom: 4px;
        }

        .suite-description {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            line-height: 1.3;
        }

        .suite-radio input[type="radio"]:checked + label .suite-name {
            color: #28a745;
        }

        .suite-radio:has(input[type="radio"]:checked) {
            background-color: rgba(40, 167, 69, 0.1);
            border-color: #28a745;
        }

        .suite-radio:has(input[type="radio"]:checked):hover {
            background-color: rgba(40, 167, 69, 0.15);
            border-color: #28a745;
        }
    </style>
</head>
<body>
    <h2>CodeQL Scanner</h2>

    <div class="section scan-section">
        <h3>Local CodeQL Scanner</h3>
        <div>
            <button onclick="runLocalScan()" id="scanButton">🔍 Run Local CodeQL Scanner</button>
            <span id="scanTimer" class="timer-display" style="display: none;"></span>
        </div>
        <div>
            <button onclick="fetchRemoteAlerts()" id="fetchButton">🔄 Fetch Remote Security Alerts</button>
        </div>
    </div>

    <div class="section" id="summarySection" style="display: none;">
        <h3>🔒 Security Alerts Summary</h3>
        <div class="summary-section">
            <div class="summary-grid">
                <div class="summary-card">
                    <div class="summary-number" id="totalAlerts">0</div>
                    <div class="summary-label">📊 Total Alerts</div>
                </div>
                <div class="summary-card critical">
                    <div class="summary-number severity-critical" id="criticalAlerts">0</div>
                    <div class="summary-label">🔥 Critical Severity</div>
                </div>
                <div class="summary-card high">
                    <div class="summary-number severity-high" id="highAlerts">0</div>
                    <div class="summary-label">⚠️ High Severity</div>
                </div>
                <div class="summary-card medium">
                    <div class="summary-number severity-medium" id="mediumAlerts">0</div>
                    <div class="summary-label">⚡ Medium Severity</div>
                </div>
                <div class="summary-card low">
                    <div class="summary-number severity-low" id="lowAlerts">0</div>
                    <div class="summary-label">ℹ️ Low Severity</div>
                </div>
            </div>

            <div id="detailsSection" style="display: none;">
                <div class="top-items">
                    <h4>🔍 Top Vulnerability Types</h4>
                    <ul class="top-list" id="topRules"></ul>
                </div>
                
                <div class="top-items">
                    <h4>📁 Most Affected Files</h4>
                    <ul class="top-list" id="topFiles"></ul>
                </div>
                
                <div class="top-items" style="margin-top: 15px;">
                    <small style="color: var(--vscode-descriptionForeground);">
                        Last scan: <span id="scanDate">Never</span>
                    </small>
                </div>
            </div>
            
            <div id="noResultsMessage" class="no-results">
                No security alerts found. Run a scan to see results.
            </div>
        </div>
    </div>

    <div class="section">
        <h3>Scan Configuration</h3>
        <div class="form-group">
            <label for="suites">Query Suite:</label>
            <div id="suitesContainer">
                <div class="suite-radio">
                    <input type="radio" id="suite-code-scanning" name="suite" value="code-scanning">
                    <label for="suite-code-scanning">
                        <span class="suite-name">Default</span>
                        <span class="suite-description">Basic code scanning queries for CI/CD</span>
                    </label>
                </div>
                <div class="suite-radio">
                    <input type="radio" id="suite-security-extended" name="suite" value="security-extended">
                    <label for="suite-security-extended">
                        <span class="suite-name">Security Extended</span>
                        <span class="suite-description">Extended security queries with additional checks</span>
                    </label>
                </div>
                <div class="suite-radio">
                    <input type="radio" id="suite-security-and-quality" name="suite" value="security-and-quality">
                    <label for="suite-security-and-quality">
                        <span class="suite-name">Security and Quality</span>
                        <span class="suite-description">Security queries plus code quality checks</span>
                    </label>
                </div>
                
            </div>
            <div class="help-text">Select the CodeQL query suite to run during analysis</div>
        </div>
        
        <div class="form-group">
            <label for="threatModel">Threat Model:</label>
            <div id="threatModelContainer">
                <div class="suite-radio">
                    <input type="radio" id="threat-remote" name="threatModel" value="Remote">
                    <label for="threat-remote">
                        <span class="suite-name">Remote</span>
                        <span class="suite-description">Analyze threats from external attackers and remote code execution</span>
                    </label>
                </div>
                <div class="suite-radio">
                    <input type="radio" id="threat-local" name="threatModel" value="Local">
                    <label for="threat-local">
                        <span class="suite-name">Local</span>
                        <span class="suite-description">Focus on local threats and privilege escalation scenarios</span>
                    </label>
                </div>
            </div>
            <div class="help-text">Select the threat model to focus the analysis on specific security scenarios</div>
        </div>
    </div>
    <div class="section">
        <h3>Langauge Selection</h3>
        <div class="form-group">
            <label for="languages">Programming Languages:</label>
            <div id="languagesContainer">
                <div style="margin-bottom: 10px;">
                    <button onclick="loadSupportedLanguages()" id="loadLanguagesButton" type="button">🔄 Load Available Languages</button>
                </div>
                <div id="languagesList" style="display: none;">
                    <!-- Language checkboxes will be populated here -->
                </div>
            </div>
            <div class="help-text">Select the programming languages to analyze. Languages are auto-detected from your CodeQL CLI installation.</div>
        </div>
    </div>

    <button onclick="saveConfig()">Save Configuration</button>
    <button onclick="loadConfig()">Reload Configuration</button>
    
    <div id="message"></div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function saveConfig() {
            const config = {
                githubToken: document.getElementById('githubToken').value,
                githubOwner: document.getElementById('githubOwner').value,
                githubRepo: document.getElementById('githubRepo').value,
                suites: [getSelectedSuite()],
                languages: getSelectedLanguages(),
                codeqlPath: document.getElementById('codeqlPath').value,
                threatModel: getSelectedThreatModel()
            };
            
            vscode.postMessage({
                command: 'saveConfig',
                config: config
            });
        }

        function getSelectedSuite() {
            const selectedRadio = document.querySelector('input[name="suite"]:checked');
            return selectedRadio ? selectedRadio.value : 'code-scanning';
        }

        function setSelectedSuite(suite) {
            const radioButton = document.querySelector('input[name="suite"][value="' + suite + '"]');
            if (radioButton) {
                radioButton.checked = true;
            } else {
                // Default to code-scanning if suite not found
                const defaultRadio = document.querySelector('input[name="suite"][value="code-scanning"]');
                if (defaultRadio) defaultRadio.checked = true;
            }
        }

        function getSelectedThreatModel() {
            const selectedRadio = document.querySelector('input[name="threatModel"]:checked');
            return selectedRadio ? selectedRadio.value : 'Remote';
        }

        function setSelectedThreatModel(threatModel) {
            const radioButton = document.querySelector('input[name="threatModel"][value="' + threatModel + '"]');
            if (radioButton) {
                radioButton.checked = true;
            } else {
                // Default to Remote if threat model not found
                const defaultRadio = document.querySelector('input[name="threatModel"][value="Remote"]');
                if (defaultRadio) defaultRadio.checked = true;
            }
        }

        function getSelectedLanguages() {
            const checkboxes = document.querySelectorAll('#languagesList input[type="checkbox"]:checked');
            return Array.from(checkboxes).map(cb => cb.value);
        }

        function setSelectedLanguages(languages) {
            const checkboxes = document.querySelectorAll('#languagesList input[type="checkbox"]');
            checkboxes.forEach(cb => {
                cb.checked = languages.includes(cb.value);
            });
        }

        function loadSupportedLanguages() {
            const button = document.getElementById('loadLanguagesButton');
            button.disabled = true;
            button.textContent = '⏳ Loading Languages...';
            
            vscode.postMessage({ command: 'loadSupportedLanguages' });
        }

        function displaySupportedLanguages(languages) {
            const container = document.getElementById('languagesList');
            const button = document.getElementById('loadLanguagesButton');
            
            if (languages.length === 0) {
                container.innerHTML = '<div style="color: var(--vscode-errorForeground); font-style: italic;">No languages found. Please check your CodeQL CLI installation.</div>';
                container.style.display = 'block';
                button.textContent = '🔄 Retry Loading Languages';
                button.disabled = false;
                return;
            }

            container.innerHTML = '';
            languages.forEach(lang => {
                const checkboxContainer = document.createElement('div');
                checkboxContainer.className = 'language-checkbox';
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = 'lang-' + lang;
                checkbox.value = lang;
                
                const icon = document.createElement('span');
                icon.className = 'language-icon language-' + lang;
                icon.textContent = getLanguageIcon(lang);
                
                const label = document.createElement('label');
                label.htmlFor = 'lang-' + lang;
                label.textContent = lang;
                
                checkboxContainer.appendChild(checkbox);
                checkboxContainer.appendChild(icon);
                checkboxContainer.appendChild(label);
                container.appendChild(checkboxContainer);
            });
            
            container.style.display = 'block';
            button.textContent = '✅ Languages Loaded';
            button.disabled = false;
        }

        function getLanguageIcon(lang) {
            const icons = {
                'javascript': 'JS',
                'typescript': 'TS',
                'python': 'PY',
                'java': 'JA',
                'csharp': 'C#',
                'cpp': 'C++',
                'go': 'GO',
                'ruby': 'RB'
            };
            return icons[lang] || lang.substring(0, 2).toUpperCase();
        }
        
        function loadConfig() {
            vscode.postMessage({ command: 'loadConfig' });
        }
        
        function testConnection() {
            vscode.postMessage({ command: 'testConnection' });
        }
        
        function runLocalScan() {
            const scanButton = document.getElementById('scanButton');
            scanButton.disabled = true;
            scanButton.textContent = '⏳ Scanning...';
            
            // Clear any previous timer display
            clearTimerDisplay('scanTimer');
            startTimer('scanTimer');
            
            vscode.postMessage({ command: 'runLocalScan' });
        }
        
        function fetchRemoteAlerts() {
            const fetchButton = document.getElementById('fetchButton');
            if (fetchButton) {
                fetchButton.disabled = true;
                fetchButton.textContent = '⏳ Fetching Alerts...';
            }
            
            // Clear any previous timer display
            clearTimerDisplay('fetchTimer');
            startTimer('fetchTimer');
            
            vscode.postMessage({ command: 'fetchRemoteAlerts' });
        }
        
        let timers = {};
        
        function startTimer(timerId) {
            const startTime = Date.now();
            timers[timerId] = {
                startTime: startTime,
                interval: setInterval(() => {
                    updateTimerDisplay(timerId, Date.now() - startTime);
                }, 100)
            };
        }
        
        function stopTimer(timerId) {
            if (timers[timerId]) {
                clearInterval(timers[timerId].interval);
                delete timers[timerId];
            }
        }
        
        function clearTimerDisplay(timerId) {
            const timerEl = document.getElementById(timerId);
            if (timerEl) {
                timerEl.textContent = '';
                timerEl.style.display = 'none';
            }
        }
        
        function updateTimerDisplay(timerId, duration) {
            const timerEl = document.getElementById(timerId);
            if (timerEl) {
                timerEl.style.display = 'inline';
                timerEl.textContent = formatDuration(duration);
            }
        }
        
        function formatDuration(milliseconds) {
            if (milliseconds < 1000) {
                return Math.floor(milliseconds / 100) / 10 + 's';
            }
            
            const seconds = Math.floor(milliseconds / 1000);
            if (seconds < 60) {
                return seconds + 's';
            }
            
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return minutes + 'm ' + (remainingSeconds > 0 ? remainingSeconds + 's' : '');
        }

        
        function showMessage(text, isError = false) {
            const messageEl = document.getElementById('message');
            messageEl.textContent = text;
            messageEl.className = isError ? 'error' : 'success';
            messageEl.style.display = 'block';
            
            setTimeout(() => {
                messageEl.style.display = 'none';
            }, 5000);
        }
        
        function updateAlertsSummary(summary) {
            const summarySection = document.getElementById('summarySection');
            const noResultsMessage = document.getElementById('noResultsMessage');
            const detailsSection = document.getElementById('detailsSection');
            
            if (summary.total === 0) {
                summarySection.style.display = 'block';
                noResultsMessage.style.display = 'block';
                detailsSection.style.display = 'none';
            } else {
                summarySection.style.display = 'block';
                noResultsMessage.style.display = 'none';
                detailsSection.style.display = 'block';
                
                // Update summary numbers
                document.getElementById('totalAlerts').textContent = summary.total;
                document.getElementById('criticalAlerts').textContent = summary.severityBreakdown.critical || 0;
                document.getElementById('highAlerts').textContent = summary.severityBreakdown.high || 0;
                document.getElementById('mediumAlerts').textContent = summary.severityBreakdown.medium || 0;
                document.getElementById('lowAlerts').textContent = summary.severityBreakdown.low || 0;
                
                // Update top rules
                const topRulesList = document.getElementById('topRules');
                topRulesList.innerHTML = '';
                summary.topRules.forEach(item => {
                    const li = document.createElement('li');
                    li.innerHTML = '<span>' + item.rule + '</span><span class="count">' + item.count + '</span>';
                    topRulesList.appendChild(li);
                });
                
                // Update top files
                const topFilesList = document.getElementById('topFiles');
                topFilesList.innerHTML = '';
                summary.topFiles.forEach(item => {
                    const li = document.createElement('li');
                    li.innerHTML = '<span>' + item.file + '</span><span class="count">' + item.count + '</span>';
                    topFilesList.appendChild(li);
                });
                
                // Update scan date
                if (summary.scanDate) {
                    const date = new Date(summary.scanDate);
                    document.getElementById('scanDate').textContent = date.toLocaleString();
                }
            }
        }
        
        // Handle messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'configLoaded':
                    const config = message.config;
                    document.getElementById('githubToken').value = config.githubToken || '';
                    document.getElementById('githubOwner').value = config.githubOwner || '';
                    document.getElementById('githubRepo').value = config.githubRepo || '';
                    
                    // Set selected suite (take first suite if multiple, default to code-scanning)
                    const selectedSuite = config.suites && config.suites.length > 0 ? config.suites[0] : 'code-scanning';
                    setSelectedSuite(selectedSuite);
                    
                    document.getElementById('codeqlPath').value = config.codeqlPath || 'codeql';
                    
                    // Set selected threat model (default to Remote)
                    const selectedThreatModel = config.threatModel || 'Remote';
                    setSelectedThreatModel(selectedThreatModel);
                    
                    // Set selected languages if available
                    if (config.languages && config.languages.length > 0) {
                        setSelectedLanguages(config.languages);
                    }
                    break;

                case 'supportedLanguagesLoaded':
                    if (message.success) {
                        displaySupportedLanguages(message.languages);
                        // Auto-load configuration after languages are loaded
                        vscode.postMessage({ command: 'loadConfig' });
                    } else {
                        const container = document.getElementById('languagesList');
                        const button = document.getElementById('loadLanguagesButton');
                        container.innerHTML = '<div style="color: var(--vscode-errorForeground); font-style: italic;">' + message.message + '</div>';
                        container.style.display = 'block';
                        button.textContent = '🔄 Retry Loading Languages';
                        button.disabled = false;
                    }
                    break;
                    
                case 'configSaved':
                    showMessage(message.message, !message.success);
                    break;
                    
                case 'connectionTest':
                    showMessage(message.message, !message.success);
                    break;
                    
                case 'scanStarted':
                    showMessage(message.message, false);
                    break;
                    
                case 'scanCompleted':
                    const scanButton = document.getElementById('scanButton');
                    scanButton.disabled = false;
                    scanButton.textContent = '🔍 Run Local CodeQL Scanner';
                    
                    stopTimer('scanTimer');
                    
                    // Show final duration in timer display
                    if (message.duration !== undefined) {
                        updateTimerDisplay('scanTimer', message.duration);
                        setTimeout(() => clearTimerDisplay('scanTimer'), 5000);
                    }
                    
                    showMessage(message.message, !message.success);
                    break;
                    
                case 'fetchStarted':
                    showMessage(message.message, false);
                    break;
                    
                case 'fetchCompleted':
                    const fetchButton = document.getElementById('fetchButton');
                    if (fetchButton) {
                        fetchButton.disabled = false;
                        fetchButton.textContent = '🔄 Fetch Remote Security Alerts';
                    }
                    
                    stopTimer('fetchTimer');
                    
                    // Show final duration in timer display
                    if (message.duration !== undefined) {
                        updateTimerDisplay('fetchTimer', message.duration);
                        setTimeout(() => clearTimerDisplay('fetchTimer'), 5000);
                    }
                    
                    showMessage(message.message, !message.success);
                    break;
                    
                case 'alertsSummaryLoaded':
                    updateAlertsSummary(message.summary);
                    break;
            }
        });
        
        // Load configuration on startup
        loadConfig();
        
        // Initialize defaults if nothing is selected
        setTimeout(() => {
            // Ensure a suite is always selected
            if (!document.querySelector('input[name="suite"]:checked')) {
                const defaultSuite = document.querySelector('input[name="suite"][value="code-scanning"]');
                if (defaultSuite) defaultSuite.checked = true;
            }
            
            // Ensure a threat model is always selected
            if (!document.querySelector('input[name="threatModel"]:checked')) {
                const defaultThreatModel = document.querySelector('input[name="threatModel"][value="Remote"]');
                if (defaultThreatModel) defaultThreatModel.checked = true;
            }
        }, 100);
        
        // Load alerts summary
        vscode.postMessage({ command: 'loadAlertsSummary' });
    </script>
</body>
</html>`;
  }
}
