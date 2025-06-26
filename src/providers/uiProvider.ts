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

    // Automatically load supported languages for the UI
    this.loadSupportedLanguages();
  }

  private async saveConfiguration(config: any) {
    this.logger.logServiceCall("UiProvider", "saveConfiguration", "started");
    const workspaceConfig = vscode.workspace.getConfiguration("codeql-scanner");

    try {
      this.logger.info(
        "UiProvider",
        `Saving configuration: ${JSON.stringify(config, null, 2)}`
      );

      await Promise.all([
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

      // Show VS Code notification for saves
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
    this.logger.info(
      "UiProvider",
      `Using threat model: ${threatModel}`
    )

    // Auto-select GitHub repository languages if no manual selection exists
    let languages = config.get<string[]>("languages", []);
    if (languages.length === 0) {
      languages = await this.autoSelectGitHubLanguages();
    }

    this.logger.info(
      "UiProvider",
      `GitHub languages auto-selected: [${languages.join(", ")}]`
    );

    const configuration = {
      githubToken: config.get<string>("github.token", ""),
      githubOwner: config.get<string>("github.owner", ""),
      githubRepo: config.get<string>("github.repo", ""),
      githubLanguages: config.get<string[]>("github.languages", []),
      suites: config.get<string[]>("suites", ["default"]),
      languages: languages,
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

  private async autoSelectGitHubLanguages(): Promise<string[]> {
    this.logger.logServiceCall(
      "UiProvider",
      "autoSelectGitHubLanguages",
      "started"
    );

    try {
      const config = vscode.workspace.getConfiguration("codeql-scanner");
      const githubLanguages = config.get<string[]>("github.languages", []);

      if (githubLanguages.length === 0) {
        this.logger.debug(
          "UiProvider",
          "No GitHub repository languages found, skipping auto-selection"
        );
        return [];
      }

      // Check if CodeQL service is available
      if (!this._codeqlService) {
        this.logger.warn(
          "UiProvider",
          "CodeQL service not available for language mapping"
        );
        return [];
      }

      // Ensure we have the supported languages loaded
      try {
        await this._codeqlService.getSupportedLanguages();
      } catch (error) {
        this.logger.warn(
          "UiProvider",
          "Failed to load CodeQL supported languages for auto-selection",
          error
        );
        return [];
      }

      // Map GitHub languages to CodeQL supported languages
      const mappedLanguages = this._codeqlService.mapLanguagesToCodeQL(githubLanguages);

      if (mappedLanguages.length > 0) {
        // Save the auto-selected languages to configuration
        await config.update(
          "languages",
          mappedLanguages,
          vscode.ConfigurationTarget.Workspace
        );

        this.logger.info(
          "UiProvider",
          `Auto-selected CodeQL languages from GitHub repository: ${mappedLanguages.join(", ")} (from GitHub languages: ${githubLanguages.join(", ")})`
        );

        // Notify the user about the auto-selection
        vscode.window.showInformationMessage(
          `Auto-selected ${mappedLanguages.length} CodeQL language(s) from your repository: ${mappedLanguages.join(", ")}`
        );

        // Send auto-selection notification to webview
        this._view?.webview.postMessage({
          command: "languagesAutoSelected",
          success: true,
          languages: mappedLanguages,
          githubLanguages: githubLanguages,
          message: `Auto-selected ${mappedLanguages.length} language(s) from your repository`
        });
      } else {
        this.logger.info(
          "UiProvider",
          `No CodeQL-supported languages found from GitHub repository languages: ${githubLanguages.join(", ")}`
        );

        // Notify about no compatible languages found
        this._view?.webview.postMessage({
          command: "languagesAutoSelected",
          success: false,
          languages: [],
          githubLanguages: githubLanguages,
          message: `No CodeQL-supported languages found in repository (detected: ${githubLanguages.join(", ")})`
        });
      }

      this.logger.logServiceCall(
        "UiProvider",
        "autoSelectGitHubLanguages",
        "completed",
        { 
          githubLanguages: githubLanguages,
          mappedLanguages: mappedLanguages
        }
      );

      return mappedLanguages;
    } catch (error) {
      this.logger.logServiceCall(
        "UiProvider",
        "autoSelectGitHubLanguages",
        "failed",
        error
      );
      return [];
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
        
        /* Enhanced Action Buttons Styling */
        .action-button {
            position: relative;
            padding: 14px 24px;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            overflow: hidden;
            min-width: 200px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            text-transform: none;
            letter-spacing: 0.3px;
            margin: 8px 8px 8px 0;
            outline: none;
            user-select: none;
        }

        .action-button::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
            transition: left 0.5s;
        }

        .action-button:hover::before {
            left: 100%;
        }

        .action-button:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
        }

        .action-button:active:not(:disabled) {
            transform: translateY(0);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
            transition: all 0.1s ease;
        }

        .action-button:focus-visible {
            outline: 2px solid var(--vscode-focusBorder);
            outline-offset: 2px;
        }

        .action-button:disabled {
            cursor: not-allowed;
            transform: none;
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.05);
            opacity: 0.7;
        }

        .action-button:disabled::before {
            display: none;
        }

        /* Local Scan Button */
        #scanButton {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
            position: relative;
        }

        #scanButton:hover:not(:disabled) {
            background: linear-gradient(135deg, #5a67d8 0%, #6b46c1 100%);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
        }

        #scanButton:disabled {
            background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%);
        }

        /* Add pulse effect for scan button */
        #scanButton::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 0;
            height: 0;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.3);
            transition: all 0.6s ease;
            transform: translate(-50%, -50%);
        }

        #scanButton:active:not(:disabled)::after {
            width: 200px;
            height: 200px;
            opacity: 0;
        }

        .scan-icon {
            font-size: 16px;
            animation: pulse 2s infinite;
            transition: all 0.3s ease;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.7; transform: scale(1.05); }
        }

        /* Fetch Remote Button */
        #fetchButton {
            background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
            color: white;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
            position: relative;
        }

        #fetchButton:hover:not(:disabled) {
            background: linear-gradient(135deg, #38a169 0%, #2f855a 100%);
            box-shadow: 0 6px 20px rgba(72, 187, 120, 0.4);
        }

        #fetchButton:disabled {
            background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%);
        }

        /* Add ripple effect for fetch button */
        #fetchButton::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 0;
            height: 0;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.3);
            transition: all 0.6s ease;
            transform: translate(-50%, -50%);
        }

        #fetchButton:active:not(:disabled)::after {
            width: 200px;
            height: 200px;
            opacity: 0;
        }

        .fetch-icon {
            font-size: 16px;
            transition: all 0.3s ease;
        }

        #fetchButton:hover:not(:disabled) .fetch-icon {
            animation: bounce 0.6s ease-in-out;
        }

        @keyframes bounce {
            0%, 20%, 60%, 100% { transform: translateY(0); }
            40% { transform: translateY(-4px); }
            80% { transform: translateY(-2px); }
        }

        /* Loading state animation */
        .action-button.loading {
            position: relative;
            color: transparent !important;
            text-shadow: none !important;
        }

        .action-button.loading::after {
            content: '';
            position: absolute;
            width: 20px;
            height: 20px;
            top: 50%;
            left: 50%;
            margin-left: -10px;
            margin-top: -10px;
            border: 2px solid transparent;
            border-top: 2px solid rgba(255, 255, 255, 0.8);
            border-radius: 50%;
            animation: loading-spin 1s linear infinite;
            z-index: 10;
        }

        @keyframes loading-spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        /* Success/Error state animations */
        .action-button.success {
            animation: success-flash 0.6s ease-in-out;
        }

        .action-button.error {
            animation: error-shake 0.6s ease-in-out;
        }

        @keyframes success-flash {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); box-shadow: 0 0 20px rgba(34, 197, 94, 0.5); }
        }

        @keyframes error-shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-4px); }
            75% { transform: translateX(4px); }
        }

        /* Enhanced button container */
        .button-group {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin: 20px 0;
        }

        .button-row {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
        }

        /* Status indicators */
        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 8px;
            border-radius: 4px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
        }

        .status-success {
            color: #22c55e;
            border-color: rgba(34, 197, 94, 0.3);
            background: rgba(34, 197, 94, 0.1);
        }

        .status-error {
            color: #ef4444;
            border-color: rgba(239, 68, 68, 0.3);
            background: rgba(239, 68, 68, 0.1);
        }

        /* Auto-save indicator styling */
        .auto-save-indicator {
            position: fixed;
            top: 20px;
            right: 20px;
            background: linear-gradient(135deg, rgba(34, 197, 94, 0.9), rgba(16, 185, 129, 0.9));
            color: white;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            backdrop-filter: blur(10px);
            box-shadow: 0 4px 12px rgba(34, 197, 94, 0.3);
            z-index: 1000;
            opacity: 0;
            transform: translateX(100px);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .auto-save-indicator.show {
            opacity: 1;
            transform: translateX(0);
        }

        .auto-save-indicator::before {
            content: '✓';
            font-size: 14px;
        }
        @media (max-width: 480px) {
            .button-row {
                flex-direction: column;
            }
            
            .action-button {
                width: 100%;
                min-width: unset;
            }
            
            .timer-display {
                margin-top: 8px;
                align-self: flex-start;
            }

            .summary-grid {
                grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
                gap: 8px;
            }

            .summary-card {
                padding: 8px 6px;
            }

            .summary-number {
                font-size: 16px;
            }

            .summary-label {
                font-size: 8px;
            }

            #detailsSection > div {
                grid-template-columns: 1fr !important;
                gap: 8px !important;
            }
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
            background: linear-gradient(135deg, rgba(102, 126, 234, 0.05) 0%, rgba(118, 75, 162, 0.05) 100%);
            border: 1px solid rgba(102, 126, 234, 0.2);
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 20px;
            position: relative;
            overflow: hidden;
        }

        .summary-section::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, #667eea, #764ba2, #48bb78, #f093fb);
            animation: shimmer 3s ease-in-out infinite;
        }

        @keyframes shimmer {
            0%, 100% { opacity: 0.6; }
            50% { opacity: 1; }
        }
        
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 10px;
            margin-bottom: 12px;
        }
        
        .summary-card {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            padding: 10px 8px;
            text-align: center;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
            backdrop-filter: blur(10px);
            cursor: pointer;
        }
        
        .summary-card:hover {
            transform: translateY(-3px) scale(1.02);
            box-shadow: 0 8px 25px rgba(0, 0, 0, 0.2);
            border-color: rgba(102, 126, 234, 0.4);
        }

        .summary-card::after {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: linear-gradient(45deg, transparent, rgba(255, 255, 255, 0.05), transparent);
            transform: rotate(45deg);
            transition: all 0.6s;
            opacity: 0;
        }

        .summary-card:hover::after {
            animation: card-shine 0.6s ease-in-out;
        }

        @keyframes card-shine {
            0% { transform: translateX(-100%) rotate(45deg); opacity: 0; }
            50% { opacity: 1; }
            100% { transform: translateX(100%) rotate(45deg); opacity: 0; }
        }
        
        .summary-card.critical {
            background: linear-gradient(135deg, rgba(255, 67, 67, 0.15) 0%, rgba(255, 67, 67, 0.08) 100%);
            border-color: rgba(255, 67, 67, 0.3);
            box-shadow: 0 0 20px rgba(255, 67, 67, 0.1);
        }
        
        .summary-card.critical:hover {
            background: linear-gradient(135deg, rgba(255, 67, 67, 0.2) 0%, rgba(255, 67, 67, 0.12) 100%);
            border-color: rgba(255, 67, 67, 0.5);
            box-shadow: 0 8px 25px rgba(255, 67, 67, 0.2);
        }
        
        .summary-card.high {
            background: linear-gradient(135deg, rgba(255, 87, 34, 0.15) 0%, rgba(255, 87, 34, 0.08) 100%);
            border-color: rgba(255, 87, 34, 0.3);
            box-shadow: 0 0 20px rgba(255, 87, 34, 0.1);
        }
        
        .summary-card.high:hover {
            background: linear-gradient(135deg, rgba(255, 87, 34, 0.2) 0%, rgba(255, 87, 34, 0.12) 100%);
            border-color: rgba(255, 87, 34, 0.5);
            box-shadow: 0 8px 25px rgba(255, 87, 34, 0.2);
        }
        
        .summary-card.medium {
            background: linear-gradient(135deg, rgba(255, 193, 7, 0.15) 0%, rgba(255, 193, 7, 0.08) 100%);
            border-color: rgba(255, 193, 7, 0.3);
            box-shadow: 0 0 20px rgba(255, 193, 7, 0.1);
        }
        
        .summary-card.medium:hover {
            background: linear-gradient(135deg, rgba(255, 193, 7, 0.2) 0%, rgba(255, 193, 7, 0.12) 100%);
            border-color: rgba(255, 193, 7, 0.5);
            box-shadow: 0 8px 25px rgba(255, 193, 7, 0.2);
        }
        
        .summary-card.low {
            background: linear-gradient(135deg, rgba(33, 150, 243, 0.15) 0%, rgba(33, 150, 243, 0.08) 100%);
            border-color: rgba(33, 150, 243, 0.3);
            box-shadow: 0 0 20px rgba(33, 150, 243, 0.1);
        }
        
        .summary-card.low:hover {
            background: linear-gradient(135deg, rgba(33, 150, 243, 0.2) 0%, rgba(33, 150, 243, 0.12) 100%);
            border-color: rgba(33, 150, 243, 0.5);
            box-shadow: 0 8px 25px rgba(33, 150, 243, 0.2);
        }
        
        .summary-number {
            font-size: 20px;
            font-weight: 700;
            color: var(--vscode-foreground);
            margin-bottom: 2px;
            display: block;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
        }
        
        .summary-label {
            font-size: 9px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            opacity: 0.8;
        }
        
        .severity-critical { 
            color: #ff6b6b !important; 
            font-weight: 700; 
            text-shadow: 0 0 8px rgba(255, 107, 107, 0.4);
            animation: critical-pulse 2s ease-in-out infinite;
        }

        @keyframes critical-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.8; transform: scale(1.05); }
        }
        
        .severity-high { 
            color: #ff8a50 !important; 
            font-weight: 700;
            text-shadow: 0 0 6px rgba(255, 138, 80, 0.3);
        }
        
        .severity-medium { 
            color: #ffd93d !important; 
            font-weight: 600;
            text-shadow: 0 0 4px rgba(255, 217, 61, 0.3);
        }
        
        .severity-low { 
            color: #74c0fc !important; 
            font-weight: 500;
            text-shadow: 0 0 3px rgba(116, 192, 252, 0.3);
        }
        
        .top-items {
            margin-top: 12px;
        }
        
        .top-items h4 {
            margin: 0 0 8px 0;
            font-size: 12px;
            color: var(--vscode-foreground);
            font-weight: 600;
            opacity: 0.9;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .top-list {
            list-style: none;
            padding: 0;
            margin: 0;
            background: rgba(255, 255, 255, 0.02);
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            overflow: hidden;
            backdrop-filter: blur(5px);
        }
        
        .top-list li {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 10px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            font-size: 11px;
            transition: all 0.2s ease;
        }
        
        .top-list li:hover {
            background: rgba(102, 126, 234, 0.1);
            transform: translateX(2px);
        }
        
        .top-list li:last-child {
            border-bottom: none;
        }
        
        .top-list li .count {
            background: linear-gradient(135deg, rgba(102, 126, 234, 0.8), rgba(118, 75, 162, 0.8));
            color: white;
            padding: 2px 6px;
            border-radius: 8px;
            font-size: 10px;
            font-weight: 600;
            min-width: 16px;
            text-align: center;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }
        
        .no-results {
            text-align: center;
            color: var(--vscode-descriptionForeground);
            padding: 16px;
            background: rgba(255, 255, 255, 0.02);
            border-radius: 8px;
            border: 1px dashed rgba(255, 255, 255, 0.1);
        }
        
        .timer-display {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            font-family: 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', 'Courier New', monospace;
            background: var(--vscode-input-background);
            padding: 6px 12px;
            border-radius: 6px;
            border: 1px solid var(--vscode-input-border);
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-width: 120px;
            justify-content: center;
        }

        .timer-display::before {
            content: '⏱️';
            font-size: 14px;
        }
        
        /* Action Section Enhancements */
        .scan-section {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            position: relative;
            overflow: hidden;
        }

        .scan-section::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #667eea, #764ba2, #48bb78);
            opacity: 0.6;
        }

        .scan-section h3 {
            margin: 0 0 16px 0;
            color: var(--vscode-foreground);
            font-size: 16px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        /* Futuristic Language Selection */
        .language-checkbox {
            position: relative;
            display: flex;
            align-items: center;
            margin-bottom: 12px;
            padding: 16px 20px;
            border-radius: 12px;
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.02) 0%, rgba(255, 255, 255, 0.08) 100%);
            border: 1px solid rgba(102, 126, 234, 0.2);
            backdrop-filter: blur(10px);
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            cursor: pointer;
            overflow: hidden;
        }

        .language-checkbox::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(102, 126, 234, 0.1), transparent);
            transition: left 0.6s;
        }

        .language-checkbox:hover::before {
            left: 100%;
        }

        .language-checkbox:hover {
            background: linear-gradient(135deg, rgba(102, 126, 234, 0.08) 0%, rgba(118, 75, 162, 0.12) 100%);
            border-color: rgba(102, 126, 234, 0.5);
            transform: translateY(-2px) scale(1.02);
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.2);
        }

        .language-checkbox.selected {
            background: linear-gradient(135deg, rgba(102, 126, 234, 0.15) 0%, rgba(118, 75, 162, 0.15) 100%);
            border-color: rgba(102, 126, 234, 0.8);
            box-shadow: 0 0 20px rgba(102, 126, 234, 0.3);
        }

        .language-checkbox.selected::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, #667eea, #764ba2);
        }

        /* Auto-selected language highlight effect */
        .language-checkbox.auto-selected {
            background: linear-gradient(135deg, rgba(34, 197, 94, 0.2) 0%, rgba(16, 185, 129, 0.2) 100%);
            border-color: rgba(34, 197, 94, 0.8);
            box-shadow: 0 0 25px rgba(34, 197, 94, 0.4);
            animation: auto-selected-pulse 3s ease-in-out;
        }

        .language-checkbox.auto-selected::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, #22c55e, #10b981);
        }

        @keyframes auto-selected-pulse {
            0%, 100% { 
                box-shadow: 0 0 25px rgba(34, 197, 94, 0.4);
                transform: scale(1);
            }
            50% { 
                box-shadow: 0 0 35px rgba(34, 197, 94, 0.6);
                transform: scale(1.02);
            }
        }

        /* Futuristic Toggle Switch */
        .language-toggle {
            position: relative;
            width: 56px;
            height: 28px;
            margin-right: 16px;
            flex-shrink: 0;
        }

        .language-checkbox input[type="checkbox"] {
            position: absolute;
            opacity: 0;
            width: 0;
            height: 0;
            pointer-events: none;
        }

        .toggle-slider {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(135deg, rgba(0, 0, 0, 0.3) 0%, rgba(0, 0, 0, 0.5) 100%);
            border: 2px solid rgba(255, 255, 255, 0.1);
            border-radius: 14px;
            cursor: pointer;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            overflow: hidden;
        }

        .toggle-slider::before {
            content: '';
            position: absolute;
            height: 20px;
            width: 20px;
            left: 2px;
            top: 2px;
            background: linear-gradient(135deg, #ffffff 0%, #e0e0e0 100%);
            border-radius: 50%;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }

        .toggle-slider::after {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent);
            transition: left 0.6s;
        }

        .language-checkbox:hover .toggle-slider::after {
            left: 100%;
        }

        input[type="checkbox"]:checked + .toggle-slider {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-color: rgba(102, 126, 234, 0.8);
            box-shadow: 0 0 15px rgba(102, 126, 234, 0.5);
        }

        input[type="checkbox"]:checked + .toggle-slider::before {
            transform: translateX(28px);
            background: linear-gradient(135deg, #ffffff 0%, #f0f0f0 100%);
            box-shadow: 0 3px 12px rgba(102, 126, 234, 0.4);
        }

        /* Pulsing effect for active toggles */
        input[type="checkbox"]:checked + .toggle-slider {
            animation: toggle-pulse 2s ease-in-out infinite;
        }

        @keyframes toggle-pulse {
            0%, 100% { box-shadow: 0 0 15px rgba(102, 126, 234, 0.5); }
            50% { box-shadow: 0 0 25px rgba(102, 126, 234, 0.8); }
        }

        .language-checkbox label {
            margin-bottom: 0;
            font-weight: 500;
            cursor: pointer;
            flex: 1;
            text-transform: capitalize;
            font-size: 14px;
            color: var(--vscode-foreground);
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .language-checkbox:hover label {
            color: rgba(102, 126, 234, 1);
        }

        .language-checkbox.selected label {
            color: rgba(102, 126, 234, 1);
            font-weight: 600;
        }

        .language-icon {
            width: 24px;
            height: 24px;
            border-radius: 6px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 700;
            text-align: center;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            flex-shrink: 0;
            position: relative;
            overflow: hidden;
        }

        .language-icon::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: inherit;
            opacity: 0.8;
            transition: opacity 0.3s ease;
        }

        .language-checkbox:hover .language-icon::before {
            opacity: 1;
        }

        .language-checkbox.selected .language-icon {
            transform: scale(1.1);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }

        /* Enhanced Load Languages Button */
        .futuristic-load-btn {
            background: linear-gradient(135deg, rgba(102, 126, 234, 0.8) 0%, rgba(118, 75, 162, 0.8) 100%) !important;
            border: 1px solid rgba(102, 126, 234, 0.5) !important;
            position: relative;
            overflow: hidden;
        }

        .futuristic-load-btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent);
            transition: left 0.5s;
        }

        .futuristic-load-btn:hover::before {
            left: 100%;
        }

        .futuristic-load-btn:hover:not(:disabled) {
            background: linear-gradient(135deg, rgba(102, 126, 234, 1) 0%, rgba(118, 75, 162, 1) 100%) !important;
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4) !important;
        }

        .futuristic-load-btn:disabled {
            background: linear-gradient(135deg, rgba(156, 163, 175, 0.6) 0%, rgba(107, 114, 128, 0.6) 100%) !important;
        }

        .load-icon {
            transition: transform 0.3s ease;
        }

        .futuristic-load-btn:hover:not(:disabled) .load-icon {
            transform: rotate(180deg);
        }

        /* Language Grid Layout */
        #languagesList {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 16px;
            padding: 20px 0;
        }

        /* Responsive adjustments */
        @media (max-width: 768px) {
            #languagesList {
                grid-template-columns: 1fr;
                gap: 12px;
            }
            
            .language-checkbox {
                padding: 14px 16px;
            }
            
            .language-toggle {
                width: 48px;
                height: 24px;
            }
            
            .toggle-slider::before {
                height: 16px;
                width: 16px;
                left: 2px;
                top: 2px;
            }
            
            input[type="checkbox"]:checked + .toggle-slider::before {
                transform: translateX(24px);
            }
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
        <h3>🚀 Actions</h3>
        <div class="button-group">
            <div class="button-row">
                <button onclick="runLocalScan()" id="scanButton" class="action-button">
                    <span class="scan-icon">🔍</span>
                    <span>Run Local CodeQL Scanner</span>
                </button>
                <span id="scanTimer" class="timer-display" style="display: none;"></span>
            </div>
            <div class="button-row">
                <button onclick="fetchRemoteAlerts()" id="fetchButton" class="action-button">
                    <span class="fetch-icon">🌐</span>
                    <span>Fetch Remote Security Alerts</span>
                </button>
                <span id="fetchTimer" class="timer-display" style="display: none;"></span>
            </div>
        </div>
    </div>

    <div class="section" id="summarySection" style="display: none;">
        <h3>🔒 Security Dashboard</h3>
        <div class="summary-section">
            <div class="summary-grid">
                <div class="summary-card">
                    <div class="summary-number" id="totalAlerts">0</div>
                    <div class="summary-label">Total</div>
                </div>
                <div class="summary-card critical">
                    <div class="summary-number severity-critical" id="criticalAlerts">0</div>
                    <div class="summary-label">Critical</div>
                </div>
                <div class="summary-card high">
                    <div class="summary-number severity-high" id="highAlerts">0</div>
                    <div class="summary-label">High</div>
                </div>
                <div class="summary-card medium">
                    <div class="summary-number severity-medium" id="mediumAlerts">0</div>
                    <div class="summary-label">Medium</div>
                </div>
                <div class="summary-card low">
                    <div class="summary-number severity-low" id="lowAlerts">0</div>
                    <div class="summary-label">Low</div>
                </div>
            </div>

            <div id="detailsSection" style="display: none;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                    <div class="top-items">
                        <h4>🎯 Top Vulnerabilities</h4>
                        <ul class="top-list" id="topRules"></ul>
                    </div>
                    
                    <div class="top-items">
                        <h4>📄 Affected Files</h4>
                        <ul class="top-list" id="topFiles"></ul>
                    </div>
                </div>
                
                <div class="top-items" style="margin-top: 10px; text-align: center;">
                    <small style="color: var(--vscode-descriptionForeground); font-size: 10px; opacity: 0.7;">
                        Last scan: <span id="scanDate" style="font-weight: 600;">Never</span>
                    </small>
                </div>
            </div>
            
            <div id="noResultsMessage" class="no-results">
                <div style="font-size: 14px; margin-bottom: 4px;">🛡️</div>
                <div style="font-size: 12px; opacity: 0.8;">No security alerts detected</div>
                <div style="font-size: 10px; opacity: 0.6; margin-top: 4px;">Run a scan to analyze your code</div>
            </div>
        </div>
    </div>

    <div class="section">
        <h3>🔍 Scan Configuration</h3>
        <div class="form-group">
            <label for="suites">Query Suite:</label>
            <div id="suitesContainer">
                <div class="suite-radio">
                    <input type="radio" id="suite-default" name="suite" value="default">
                    <label for="suite-default">
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
    <div class="section scan-section">
        <h3>🔤 Language Selection</h3>
        <div class="form-group">
            <label for="languages">Programming Languages:</label>
            <div id="languagesContainer">
                <div id="languagesList" style="display: none;">
                    <!-- Language checkboxes will be populated here -->
                </div>
                <div style="margin-bottom: 20px;">
                    <button onclick="loadSupportedLanguages()" id="loadLanguagesButton" type="button" class="action-button futuristic-load-btn" style="min-width: auto; padding: 12px 20px; font-size: 13px;">
                        <span class="load-icon">🔄</span>
                        <span>Load Available Languages</span>
                    </button>
                </div>
            </div>
            <div class="help-text">Select the programming languages to analyze. Languages are auto-detected from your CodeQL CLI installation.</div>
        </div>
    </div>

    <div id="message"></div>
    
    <!-- Auto-save indicator -->
    <div id="autoSaveIndicator" class="auto-save-indicator">
        Configuration auto-saved
    </div>

    <button onclick="saveConfig()">Save Configuration</button>
    <button onclick="loadConfig()">Reload Configuration</button>

    <script>
        const vscode = acquireVsCodeApi();
        
        function saveConfig() {
            console.log('Saving configuration...');
            const config = {
                suites: [getSelectedSuite()],
                languages: getSelectedLanguages(),
                threatModel: getSelectedThreatModel()
            };
            
            console.log('Configuration to save:', config);
            
            vscode.postMessage({
                command: 'saveConfig',
                config: config
            });
            
            // Show auto-save indicator for automatic saves
            showAutoSaveIndicator();
        }

        function getSelectedSuite() {
            const selectedRadio = document.querySelector('input[name="suite"]:checked');
            return selectedRadio ? selectedRadio.value : 'default';
        }

        function setSelectedSuite(suite) {
            const radioButton = document.querySelector('input[name="suite"][value="' + suite + '"]');
            if (radioButton) {
                radioButton.checked = true;
            } else {
                // Default to default if suite not found
                const defaultRadio = document.querySelector('input[name="suite"][value="default"]');
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
                const isSelected = languages.includes(cb.value);
                cb.checked = isSelected;
                
                // Update visual state for futuristic design
                const checkboxContainer = cb.closest('.language-checkbox');
                if (checkboxContainer) {
                    if (isSelected) {
                        checkboxContainer.classList.add('selected');
                    } else {
                        checkboxContainer.classList.remove('selected');
                    }
                }
            });
        }

        function loadSupportedLanguages() {
            const button = document.getElementById('loadLanguagesButton');
            const loadIcon = button.querySelector('.load-icon');
            const loadText = button.querySelector('span:last-child');
            
            button.disabled = true;
            loadIcon.textContent = '⏳';
            loadText.textContent = 'Loading Languages...';
            
            vscode.postMessage({ command: 'loadSupportedLanguages' });
        }

        function displaySupportedLanguages(languages) {
            const container = document.getElementById('languagesList');
            const button = document.getElementById('loadLanguagesButton');
            const loadIcon = button.querySelector('.load-icon');
            const loadText = button.querySelector('span:last-child');
            
            if (languages.length === 0) {
                container.innerHTML = '<div style="color: var(--vscode-errorForeground); font-style: italic;">No languages found. Please check your CodeQL CLI installation.</div>';
                container.style.display = 'block';
                loadIcon.textContent = '🔄';
                loadText.textContent = 'Retry Loading Languages';
                button.disabled = false;
                return;
            }

            container.innerHTML = '';
            languages.forEach(lang => {
                const checkboxContainer = document.createElement('div');
                checkboxContainer.className = 'language-checkbox';
                
                // Create toggle structure
                const toggleContainer = document.createElement('div');
                toggleContainer.className = 'language-toggle';
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = 'lang-' + lang;
                checkbox.value = lang;
                
                const toggleSlider = document.createElement('div');
                toggleSlider.className = 'toggle-slider';
                
                toggleContainer.appendChild(checkbox);
                toggleContainer.appendChild(toggleSlider);
                
                // Add event listener for automatic configuration saving
                checkbox.addEventListener('change', function() {
                    console.log('Language checkbox changed:', lang, 'checked:', checkbox.checked);
                    
                    // Update visual state
                    if (checkbox.checked) {
                        checkboxContainer.classList.add('selected');
                    } else {
                        checkboxContainer.classList.remove('selected');
                    }
                    
                    // Auto-save configuration when language selection changes
                    saveConfig();
                });
                checkbox.setAttribute('data-listener-attached', 'true');
                
                // Add direct event listener to the toggle slider for better UX
                toggleSlider.addEventListener('click', function(e) {
                    console.log('Toggle slider clicked for:', lang);
                    e.preventDefault();
                    e.stopPropagation();
                    checkbox.checked = !checkbox.checked;
                    console.log('Checkbox state changed to:', checkbox.checked);
                    // Manually trigger the change event which will call saveConfig()
                    checkbox.dispatchEvent(new Event('change'));
                });
                
                // Also add event listener to the entire toggle container for maximum clickable area
                toggleContainer.addEventListener('click', function(e) {
                    console.log('Toggle container clicked for:', lang);
                    e.preventDefault();
                    e.stopPropagation();
                    checkbox.checked = !checkbox.checked;
                    console.log('Checkbox state changed to:', checkbox.checked, 'via toggle container');
                    // Manually trigger the change event which will call saveConfig()
                    checkbox.dispatchEvent(new Event('change'));
                });
                
                const icon = document.createElement('span');
                icon.className = 'language-icon language-' + lang;
                icon.textContent = getLanguageIcon(lang);
                
                const label = document.createElement('label');
                label.htmlFor = 'lang-' + lang;
                label.innerHTML = icon.outerHTML + '<span>' + lang + '</span>';
                
                // Make the entire container clickable, but prevent double events
                checkboxContainer.addEventListener('click', function(e) {
                    console.log('Container clicked for:', lang, 'target:', e.target.className, 'checkbox:', e.target === checkbox, 'toggleSlider:', e.target === toggleSlider);
                    
                    // Only trigger click if the target is not the checkbox itself or its toggle components
                    if (e.target !== checkbox && e.target !== toggleSlider && !toggleContainer.contains(e.target)) {
                        console.log('Container click triggering checkbox change for:', lang);
                        e.preventDefault();
                        checkbox.checked = !checkbox.checked;
                        // Manually trigger the change event
                        checkbox.dispatchEvent(new Event('change'));
                    } else {
                        console.log('Container click ignored for:', lang, 'due to target being toggle component');
                    }
                });
                
                checkboxContainer.appendChild(toggleContainer);
                checkboxContainer.appendChild(label);
                container.appendChild(checkboxContainer);
            });
            
            container.style.display = 'block';
            loadIcon.textContent = '✅';
            loadText.textContent = 'Languages Loaded';
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
            scanButton.classList.add('loading');
            
            // Update text and icon
            const scanIcon = scanButton.querySelector('.scan-icon');
            const scanText = scanButton.querySelector('span:last-child');
            scanIcon.textContent = '⏳';
            scanText.textContent = 'Scanning in Progress...';
            
            // Clear any previous timer display
            clearTimerDisplay('scanTimer');
            startTimer('scanTimer');
            
            vscode.postMessage({ command: 'runLocalScan' });
        }
        
        function fetchRemoteAlerts() {
            const fetchButton = document.getElementById('fetchButton');
            if (fetchButton) {
                fetchButton.disabled = true;
                fetchButton.classList.add('loading');
                
                // Update text and icon
                const fetchIcon = fetchButton.querySelector('.fetch-icon');
                const fetchText = fetchButton.querySelector('span:last-child');
                fetchIcon.textContent = '⚡';
                fetchText.textContent = 'Fetching Alerts...';
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
        
        function showAutoSaveIndicator() {
            const indicator = document.getElementById('autoSaveIndicator');
            indicator.classList.add('show');
            
            setTimeout(() => {
                indicator.classList.remove('show');
            }, 2000);
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
                    console.log('Configuration loaded:', config);
                    
                    // Set selected suite (take first suite if multiple, default to default)
                    const selectedSuite = config.suites && config.suites.length > 0 ? config.suites[0] : 'default';
                    setSelectedSuite(selectedSuite);
                    
                    // Set selected threat model (default to Remote)
                    const selectedThreatModel = config.threatModel || 'Remote';
                    setSelectedThreatModel(selectedThreatModel);
                    
                    // Set selected languages if available
                    if (config.languages && config.languages.length > 0) {
                        console.log('Setting selected languages:', config.languages);
                        setSelectedLanguages(config.languages);
                    } else {
                        console.log('No languages found in config, defaulting to empty selection');
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
                        const loadIcon = button.querySelector('.load-icon');
                        const loadText = button.querySelector('span:last-child');
                        
                        container.innerHTML = '<div style="color: var(--vscode-errorForeground); font-style: italic;">' + message.message + '</div>';
                        container.style.display = 'block';
                        loadIcon.textContent = '🔄';
                        loadText.textContent = 'Retry Loading Languages';
                        button.disabled = false;
                    }
                    break;
                    
                case 'languagesAutoSelected':
                    if (message.success && message.languages.length > 0) {
                        // Show success message with animation
                        showMessage('Auto-selected ' + message.languages.length + ' language(s): ' + message.languages.join(', '), false);
                        
                        // Update the language selection UI if languages are loaded
                        setTimeout(() => {
                            setSelectedLanguages(message.languages);
                            
                            // Add a subtle highlight effect to auto-selected languages
                            message.languages.forEach(lang => {
                                const checkbox = document.querySelector('#lang-' + lang);
                                if (checkbox) {
                                    const container = checkbox.closest('.language-checkbox');
                                    if (container) {
                                        container.classList.add('auto-selected');
                                        // Remove the highlight after 3 seconds
                                        setTimeout(() => {
                                            container.classList.remove('auto-selected');
                                        }, 3000);
                                    }
                                }
                            });
                        }, 500);
                    } else {
                        // Show info message about no compatible languages
                        if (message.githubLanguages && message.githubLanguages.length > 0) {
                            showMessage('Repository languages detected (' + message.githubLanguages.join(', ') + ') but none are CodeQL-compatible', false);
                        }
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
                    scanButton.classList.remove('loading');
                    
                    // Add success or error animation
                    if (message.success) {
                        scanButton.classList.add('success');
                        setTimeout(() => scanButton.classList.remove('success'), 600);
                    } else {
                        scanButton.classList.add('error');
                        setTimeout(() => scanButton.classList.remove('error'), 600);
                    }
                    
                    // Reset text and icon
                    const scanIcon = scanButton.querySelector('.scan-icon');
                    const scanText = scanButton.querySelector('span:last-child');
                    
                    if (message.success) {
                        scanIcon.textContent = '✅';
                        scanText.textContent = 'Scan Completed Successfully';
                        
                        // Reset to normal state after 3 seconds
                        setTimeout(() => {
                            scanIcon.textContent = '🔍';
                            scanText.textContent = 'Run Local CodeQL Scanner';
                        }, 3000);
                    } else {
                        scanIcon.textContent = '❌';
                        scanText.textContent = 'Scan Failed';
                        
                        // Reset to normal state after 3 seconds
                        setTimeout(() => {
                            scanIcon.textContent = '🔍';
                            scanText.textContent = 'Run Local CodeQL Scanner';
                        }, 3000);
                    }
                    
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
                        fetchButton.classList.remove('loading');
                        
                        // Add success or error animation
                        if (message.success) {
                            fetchButton.classList.add('success');
                            setTimeout(() => fetchButton.classList.remove('success'), 600);
                        } else {
                            fetchButton.classList.add('error');
                            setTimeout(() => fetchButton.classList.remove('error'), 600);
                        }
                        
                        // Reset text and icon
                        const fetchIcon = fetchButton.querySelector('.fetch-icon');
                        const fetchText = fetchButton.querySelector('span:last-child');
                        
                        if (message.success) {
                            fetchIcon.textContent = '✅';
                            fetchText.textContent = 'Alerts Fetched Successfully';
                            
                            // Reset to normal state after 3 seconds
                            setTimeout(() => {
                                fetchIcon.textContent = '🌐';
                                fetchText.textContent = 'Fetch Remote Security Alerts';
                            }, 3000);
                        } else {
                            fetchIcon.textContent = '❌';
                            fetchText.textContent = 'Fetch Failed';
                            
                            // Reset to normal state after 3 seconds
                            setTimeout(() => {
                                fetchIcon.textContent = '🌐';
                                fetchText.textContent = 'Fetch Remote Security Alerts';
                            }, 3000);
                        }
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
                const defaultSuite = document.querySelector('input[name="suite"][value="default"]');
                if (defaultSuite) defaultSuite.checked = true;
            }
            
            // Ensure a threat model is always selected
            if (!document.querySelector('input[name="threatModel"]:checked')) {
                const defaultThreatModel = document.querySelector('input[name="threatModel"][value="Remote"]');
                if (defaultThreatModel) defaultThreatModel.checked = true;
            }
            
            // Add auto-save event listeners to all radio buttons
            const suiteRadios = document.querySelectorAll('input[name="suite"]');
            suiteRadios.forEach(radio => {
                if (!radio.hasAttribute('data-listener-attached')) {
                    radio.addEventListener('change', function() {
                        // Auto-save configuration when suite selection changes
                        saveConfig();
                    });
                    radio.setAttribute('data-listener-attached', 'true');
                }
            });
            
            const threatModelRadios = document.querySelectorAll('input[name="threatModel"]');
            threatModelRadios.forEach(radio => {
                if (!radio.hasAttribute('data-listener-attached')) {
                    radio.addEventListener('change', function() {
                        // Auto-save configuration when threat model selection changes
                        saveConfig();
                    });
                    radio.setAttribute('data-listener-attached', 'true');
                }
            });
        }, 100);
        
        // Load alerts summary
        vscode.postMessage({ command: 'loadAlertsSummary' });
    </script>
</body>
</html>`;
  }
}
