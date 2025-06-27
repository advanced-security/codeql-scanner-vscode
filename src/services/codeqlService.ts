import * as vscode from "vscode";
import { GitHubService, RepositoryInfo } from "./githubService";
import { LoggerService } from "./loggerService";
import * as path from "path";
import * as fs from "fs";
import * as yaml from "js-yaml";
import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os";

const execAsync = promisify(exec);

export interface FlowStep {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  message?: string;
  stepIndex: number;
}

export interface ScanResult {
  ruleId: string;
  severity: string;
  message: string;
  language?: string; // Optional language field
  location: {
    file: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  flowSteps?: FlowStep[]; // Data flow steps from source to sink
}

export class CodeQLService {
  private githubService: GitHubService;
  private logger: LoggerService;
  private languages: { [key: string]: string[] } = {
    javascript: ["javascript", "typescript", "js", "ts", "jsx", "tsx"],
    python: ["python", "py"],
    java: ["java"],
    csharp: ["csharp", "c#", "cs"],
    cpp: ["cpp", "c++", "c", "cc", "cxx"],
    go: ["go", "golang"],
    ruby: ["ruby", "rb"],
    swift: ["swift"],
    kotlin: ["kotlin", "kt"],
    scala: ["scala"],
  };
  private resultsCallback?: (results: ScanResult[]) => void;

  constructor(githubService: GitHubService) {
    this.githubService = githubService;
    this.logger = LoggerService.getInstance();
  }

  public setResultsCallback(callback: (results: ScanResult[]) => void): void {
    this.resultsCallback = callback;
  }

  public async runScan(
    progress: vscode.Progress<{ increment?: number; message?: string }>,
    cancellationToken: vscode.CancellationToken
  ): Promise<ScanResult[]> {
    this.logger.logServiceCall("CodeQLService", "runScan", "started");

    const config = vscode.workspace.getConfiguration("codeql-scanner");
    const useLocalScan = config.get<boolean>("useLocalScan", true);

    this.logger.info(
      "CodeQLService",
      `Using ${useLocalScan ? "local" : "remote"} scan mode`
    );

    try {
      let results;
      if (useLocalScan) {
        results = await this.runLocalScan(progress, cancellationToken);
      } else {
        results = await this.runRemoteScan(progress, cancellationToken);
      }

      this.logger.logServiceCall("CodeQLService", "runScan", "completed", {
        resultCount: results.length,
      });
      return results;
    } catch (error) {
      this.logger.logServiceCall("CodeQLService", "runScan", "failed", error);
      throw error;
    }
  }

  private async runLocalScan(
    progress: vscode.Progress<{ increment?: number; message?: string }>,
    cancellationToken: vscode.CancellationToken
  ): Promise<ScanResult[]> {
    progress.report({
      increment: 5,
      message: "Initializing local CodeQL scan...",
    });

    // Check if CodeQL CLI is available
    await this.checkCodeQLCLI();
    await this.getSupportedLanguages();

    progress.report({ increment: 10, message: "Setting up directories..." });

    // Setup directories
    const codeqlDir = this.getCodeQLDirectory();
    const workspaceFolder = this.getWorkspaceFolder();
    const repoName = this.getRepositoryName();
    const currentSHA = await this.getCurrentGitSHA();

    progress.report({ increment: 15, message: "Detecting languages..." });

    // Get languages and search paths from configuration
    const config = vscode.workspace.getConfiguration("codeql-scanner");

    var languages = config.get<string[]>("languages", []);
    if (!languages || languages.length === 0) {
      languages = this.mapLanguagesToCodeQL(
        config.get<string[]>("github.languages", [])
      );

      this.logger.info(
        "CodeQLService",
        "Updating languages from GitHub repository"
      );
      config.update(
        "languages",
        languages,
        vscode.ConfigurationTarget.Workspace
      );
    }

    this.logger.info(
      "CodeQLService",
      `Detected languages: [${languages.join(", ")}]`
    );

    const searchPaths = config.get<string[]>("searchPaths", ["src/", "lib/"]);

    const results: ScanResult[] = [];

    // Process each language
    for (let i = 0; i < languages.length; i++) {
      const language = languages[i];
      const progressBase = 20 + (i / languages.length) * 60;

      if (cancellationToken.isCancellationRequested) {
        throw new Error("Operation cancelled");
      }

      // progress.report({
      //   increment: progressBase,
      //   message: `Checking ${language} support...`,
      // });
      // await this.installPack(`codeql/${language}-queries`);

      progress.report({
        increment: progressBase,
        message: `Creating ${language} database...`,
      });

      // Create database for this language
      const databasePath = await this.createCodeQLDatabase(
        language,
        searchPaths,
        repoName,
        workspaceFolder,
        codeqlDir,
        progress,
        cancellationToken
      );

      progress.report({
        increment: progressBase + 20,
        message: `Analyzing ${language} database...`,
      });

      // Analyze database
      const sarif = await this.analyzeCodeQLDatabase(
        databasePath,
        repoName,
        language,
        currentSHA,
        codeqlDir,
        progress,
        cancellationToken
      );

      progress.report({
        increment: progressBase + 35,
        message: `Processing ${language} results...`,
      });

      // Parse SARIF results
      const languageResults = this.parseSARIFResults(
        sarif,
        workspaceFolder,
        language
      );
      results.push(...languageResults);

      // Notify UI immediately with updated results
      if (this.resultsCallback && languageResults.length > 0) {
        this.resultsCallback([...results]); // Send a copy of all results so far
      }
    }

    progress.report({ increment: 95, message: "Finalizing results..." });

    return results;
  }

  private async runRemoteScan(
    progress: vscode.Progress<{ increment?: number; message?: string }>,
    cancellationToken: vscode.CancellationToken
  ): Promise<ScanResult[]> {
    // Original GitHub Actions implementation
    progress.report({
      increment: 10,
      message: "Getting repository information...",
    });

    const repoInfo = await this.githubService.getRepositoryInfo();

    if (cancellationToken.isCancellationRequested) {
      throw new Error("Operation cancelled");
    }

    progress.report({ increment: 30, message: "Triggering CodeQL scan..." });

    await this.githubService.triggerCodeQLScan(repoInfo.owner, repoInfo.repo);

    progress.report({ increment: 60, message: "Waiting for scan results..." });

    // Wait a bit and then check for results
    await this.waitForAnalysis(repoInfo, progress, cancellationToken);

    progress.report({ increment: 90, message: "Fetching alerts..." });

    const alerts = await this.githubService.getCodeQLAlerts(
      repoInfo.owner,
      repoInfo.repo
    );

    const results = this.convertAlertsToResults(alerts);

    // Notify UI immediately when remote results are available
    if (this.resultsCallback && results.length > 0) {
      this.resultsCallback(results);
    }

    return results;
  }

  public async initRepository(
    progress: vscode.Progress<{ increment?: number; message?: string }>,
    cancellationToken: vscode.CancellationToken
  ): Promise<void> {
    progress.report({
      increment: 10,
      message: "Getting repository information...",
    });

    const repoInfo = await this.githubService.getRepositoryInfo();

    if (cancellationToken.isCancellationRequested) {
      throw new Error("Operation cancelled");
    }

    progress.report({
      increment: 30,
      message: "Creating CodeQL configuration...",
    });

    await this.createCodeQLConfig(repoInfo);

    progress.report({ increment: 60, message: "Creating GitHub workflow..." });

    await this.createGitHubWorkflow(repoInfo);

    progress.report({ increment: 90, message: "Finalizing setup..." });
  }

  public async getVersion(): Promise<string> {
    try {
      const config = vscode.workspace.getConfiguration("codeql-scanner");
      const codeqlPath = config.get<string>("codeqlPath", "codeql");

      const { stdout } = await execAsync(
        `${codeqlPath} version -v --log-to-stderr --format=json`
      );
      const versionInfo = JSON.parse(stdout);

      return versionInfo.version || "unknown";
    } catch (error) {
      this.logger.error("CodeQLService", "Error getting CodeQL version", error);
      throw new Error(
        "Failed to get CodeQL version. Please check your configuration."
      );
    }
  }

  /**
   * List of supported languages by CodeQL CLI.
   *
   * Creates a map of supported languages with aliases.
   *
   * @returns
   */
  public async getSupportedLanguages(): Promise<{ [key: string]: string[] }> {
    this.logger.info(
      "CodeQLService",
      "Getting supported languages from CodeQL CLI"
    );
    try {
      const config = vscode.workspace.getConfiguration("codeql-scanner");
      const codeqlPath = config.get<string>("codeqlPath", "codeql");

      const command = `${codeqlPath} resolve languages --format=betterjson`;
      this.logger.info(
        "CodeQLService",
        `Running command to get supported languages: ${command}`
      );

      const { stdout } = await execAsync(command, {
        timeout: 30000, // 30 seconds timeout
      });

      this.logger.info(
        "CodeQLService",
        "Successfully retrieved supported languages"
      );

      const languagesInfo = JSON.parse(stdout);

      //
      const extractors: { [key: string]: any } = languagesInfo.extractors || {};
      this.logger.info(
        "CodeQLService",
        `Found ${Object.keys(extractors).length} language extractors`
      );

      for (const [lang, extractor] of Object.entries(extractors)) {
        var name = lang.toLowerCase();

        if (!this.languages[name]) {
          this.languages[name] = [];
        }
      }

      this.logger.info(
        "CodeQLService",
        `Supported languages: ${this.getLanguages().join(", ")}`
      );

      return this.languages;
    } catch (error) {
      this.logger.error(
        "CodeQLService",
        "Error getting supported languages",
        error
      );
      throw new Error(
        "Failed to get supported languages. Please check your configuration."
      );
    }
  }

  public getLanguages(): string[] {
    // return Object.keys(this.languages).map((key) => this.languages[key]);
    return Object.keys(this.languages);
  }

  /**
   * Return a unique list of languages supported by CodeQL CLI
   * @param languages Languages from GitHub repository
   * @returns
   */
  public mapLanguagesToCodeQL(languages: string[]): string[] {
    const results: string[] = [];
    const addedLanguages = new Set<string>();

    for (const language of languages) {
      const lang = language.toLowerCase();

      // Direct match with CodeQL language
      if (this.languages[lang] && !addedLanguages.has(lang)) {
        results.push(lang);
        addedLanguages.add(lang);
        continue;
      }
      //TODO: If language detected is typescript, map it to javascript
      // Check if it's an alias for a CodeQL language
      for (const [codeqlLang, aliases] of Object.entries(this.languages)) {
        if (aliases.includes(lang) && !addedLanguages.has(codeqlLang)) {
          results.push(codeqlLang);
          addedLanguages.add(codeqlLang);
          break;
        }
      }
    }

    return [...new Set(results)]; // Remove any duplicates just in case
  }

  public async runAnalysis(
    progress: vscode.Progress<{ increment?: number; message?: string }>,
    cancellationToken: vscode.CancellationToken
  ): Promise<void> {
    progress.report({
      increment: 10,
      message: "Getting repository information...",
    });

    const repoInfo = await this.githubService.getRepositoryInfo();

    if (cancellationToken.isCancellationRequested) {
      throw new Error("Operation cancelled");
    }

    progress.report({ increment: 30, message: "Getting analysis history..." });

    const analyses = await this.githubService.getCodeQLAnalyses(
      repoInfo.owner,
      repoInfo.repo
    );

    progress.report({
      increment: 70,
      message: "Processing analysis results...",
    });

    // Show analysis results in a new document
    await this.showAnalysisResults(analyses);
  }

  private async waitForAnalysis(
    repoInfo: RepositoryInfo,
    progress: vscode.Progress<{ increment?: number; message?: string }>,
    cancellationToken: vscode.CancellationToken,
    maxWaitTime = 300000 // 5 minutes
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      if (cancellationToken.isCancellationRequested) {
        throw new Error("Operation cancelled");
      }

      try {
        const analyses = await this.githubService.getCodeQLAnalyses(
          repoInfo.owner,
          repoInfo.repo
        );
        const recentAnalysis = analyses[0];

        if (recentAnalysis && recentAnalysis.status === "completed") {
          return;
        }

        progress.report({
          message: `Waiting for analysis (${recentAnalysis?.status || "pending"
            })...`,
        });
      } catch (error) {
        // Continue waiting even if there's an error
        this.logger.error(
          "CodeQLService",
          "Error checking analysis status",
          error
        );
      }

      // Wait 10 seconds before checking again
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    throw new Error("Analysis timeout - check GitHub Actions for status");
  }

  private convertAlertsToResults(alerts: any[]): ScanResult[] {
    return alerts.map((alert) => {
      // Extract flow steps if available from GitHub API
      const flowSteps: FlowStep[] = [];
      if (alert.instances && alert.instances.length > 0) {
        const instance = alert.instances[0];
        if (instance.flow && instance.flow.locations) {
          instance.flow.locations.forEach(
            (flowLocation: any, index: number) => {
              if (flowLocation.location) {
                flowSteps.push({
                  file: flowLocation.location.path,
                  startLine: flowLocation.location.start_line,
                  startColumn: flowLocation.location.start_column,
                  endLine: flowLocation.location.end_line,
                  endColumn: flowLocation.location.end_column,
                  message: flowLocation.message,
                  stepIndex: index,
                });
              }
            }
          );
        }
      }

      return {
        ruleId: alert.rule.id,
        severity: alert.rule.severity,
        message: alert.message.text,
        location: {
          file: alert.most_recent_instance.location.path,
          startLine: alert.most_recent_instance.location.start_line,
          startColumn: alert.most_recent_instance.location.start_column,
          endLine: alert.most_recent_instance.location.end_line,
          endColumn: alert.most_recent_instance.location.end_column,
        },
        flowSteps: flowSteps.length > 0 ? flowSteps : undefined,
      };
    });
  }

  private async createCodeQLConfig(repoInfo: RepositoryInfo): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("No workspace folder found");
    }

    const config = vscode.workspace.getConfiguration("codeql-scanner");
    const searchPaths = config.get<string[]>("searchPaths", ["src/", "lib/"]);
    const suites = config.get<string[]>("suites", ["security-extended"]);

    const codeqlConfig = {
      name: "CodeQL Configuration",
      "disable-default-path-filters": false,
      paths: searchPaths,
      "paths-ignore": [
        "node_modules",
        "dist",
        "build",
        "**/*.test.*",
        "**/*.spec.*",
      ],
      queries: suites.map((suite) => ({
        uses: suite,
      })),
    };

    const configPath = path.join(
      workspaceFolders[0].uri.fsPath,
      ".github",
      "codeql",
      "codeql-config.yml"
    );

    // Create directory if it doesn't exist
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Write config file
    const yamlContent = yaml.dump(codeqlConfig, { indent: 2 });
    fs.writeFileSync(configPath, yamlContent);

    vscode.window.showInformationMessage(
      `CodeQL configuration created at ${configPath}`
    );
  }

  private async createGitHubWorkflow(repoInfo: RepositoryInfo): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("No workspace folder found");
    }

    const config = vscode.workspace.getConfiguration("codeql-scanner");
    const languages = config.get<string[]>("languages", repoInfo.languages);

    const workflow = {
      name: "CodeQL Analysis",
      on: {
        push: {
          branches: [repoInfo.defaultBranch],
        },
        pull_request: {
          branches: [repoInfo.defaultBranch],
        },
        workflow_dispatch: {
          inputs: {
            languages: {
              description: "Languages to analyze",
              required: false,
              default: languages.join(","),
            },
          },
        },
      },
      jobs: {
        analyze: {
          name: "Analyze",
          "runs-on": "ubuntu-latest",
          permissions: {
            actions: "read",
            contents: "read",
            "security-events": "write",
          },
          strategy: {
            fail_fast: false,
            matrix: {
              language: languages,
            },
          },
          steps: [
            {
              name: "Checkout repository",
              uses: "actions/checkout@v3",
            },
            {
              name: "Initialize CodeQL",
              uses: "github/codeql-action/init@v2",
              with: {
                languages: "${{ matrix.language }}",
                "config-file": "./.github/codeql/codeql-config.yml",
              },
            },
            {
              name: "Autobuild",
              uses: "github/codeql-action/autobuild@v2",
            },
            {
              name: "Perform CodeQL Analysis",
              uses: "github/codeql-action/analyze@v2",
            },
          ],
        },
      },
    };

    const workflowPath = path.join(
      workspaceFolders[0].uri.fsPath,
      ".github",
      "workflows",
      "codeql-analysis.yml"
    );

    // Create directory if it doesn't exist
    const workflowDir = path.dirname(workflowPath);
    if (!fs.existsSync(workflowDir)) {
      fs.mkdirSync(workflowDir, { recursive: true });
    }

    // Write workflow file
    const yamlContent = yaml.dump(workflow, { indent: 2 });
    fs.writeFileSync(workflowPath, yamlContent);

    vscode.window.showInformationMessage(
      `GitHub workflow created at ${workflowPath}`
    );
  }

  private async showAnalysisResults(analyses: any[]): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
      content: this.formatAnalysisResults(analyses),
      language: "markdown",
    });

    await vscode.window.showTextDocument(document);
  }

  private formatAnalysisResults(analyses: any[]): string {
    let content = "# CodeQL Analysis Results\n\n";

    if (analyses.length === 0) {
      content += "No analyses found.\n";
      return content;
    }

    analyses.forEach((analysis, index) => {
      content += `## Analysis ${index + 1}\n\n`;
      content += `- **ID**: ${analysis.id}\n`;
      content += `- **Reference**: ${analysis.ref}\n`;
      content += `- **Status**: ${analysis.status}\n`;
      content += `- **Created**: ${new Date(
        analysis.createdAt
      ).toLocaleString()}\n`;

      if (analysis.completedAt) {
        content += `- **Completed**: ${new Date(
          analysis.completedAt
        ).toLocaleString()}\n`;
      }

      if (analysis.resultsCount !== undefined) {
        content += `- **Results**: ${analysis.resultsCount} alerts\n`;
      }

      content += `- **URL**: [View on GitHub](${analysis.url})\n\n`;
    });

    return content;
  }

  // Local CodeQL CLI methods
  private async checkCodeQLCLI(): Promise<void> {
    const config = vscode.workspace.getConfiguration("codeql-scanner");
    const codeqlPath = config.get<string>("codeqlPath", "codeql");

    try {
      const version = await this.getVersion();
      this.logger.info("CodeQLService", `CodeQL CLI version: ${version}`);
    } catch (error) {
      this.logger.error(
        "CodeQLService",
        `CodeQL CLI not found at '${codeqlPath}'`,
        error
      );
      throw new Error(
        `CodeQL CLI not found at '${codeqlPath}'. Please install CodeQL CLI and configure the path in settings.`
      );
    }
  }

  private getCodeQLDirectory(): string {
    const homeDir = os.homedir();
    const codeqlDir = path.join(homeDir, ".codeql");

    // Create directories if they don't exist
    const dbDir = path.join(codeqlDir, "databases");
    const resultsDir = path.join(codeqlDir, "results");

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    return codeqlDir;
  }

  private getCodeQLDatabase(language: string): string {
    const codeqlDir = this.getCodeQLDirectory();
    const dbDir = path.join(
      codeqlDir,
      "databases",
      this.getRepositoryName(),
      language
    );
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    return dbDir;
  }

  private getCodeQLConfig(): string {
    const codeqlDir = this.getCodeQLDirectory();
    const configPath = path.join(
      codeqlDir,
      this.getRepositoryName(),
      "config.yml"
    );
    return configPath;
  }

  private getCodeQLResults(): string {
    const codeqlDir = this.getCodeQLDirectory();
    const resultsDir = path.join(codeqlDir, "results");
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }
    return resultsDir;
  }

  private getWorkspaceFolder(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("No workspace folder found");
    }
    return workspaceFolders[0].uri.fsPath;
  }

  private getRepositoryName(): string {
    const workspaceFolder = this.getWorkspaceFolder();
    return path.basename(workspaceFolder);
  }

  private async getCurrentGitSHA(): Promise<string> {
    try {
      const workspaceFolder = this.getWorkspaceFolder();
      const { stdout } = await execAsync("git rev-parse HEAD", {
        cwd: workspaceFolder,
      });
      return stdout.trim().substring(0, 8); // Short SHA
    } catch (error) {
      return "unknown";
    }
  }

  private async installPack(name: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("codeql-scanner");
    const codeqlPath = config.get<string>("codeqlPath", "codeql");

    this.logger.info(
      "CodeQLService",
      `Installing CodeQL pack: ${name} using CLI at ${codeqlPath}`
    );

    try {
      const command = `${codeqlPath} pack download ${name}`;
      this.logger.info("CodeQLService", `Installing pack: ${name}`);

      const { stdout, stderr } = await execAsync(command, {
        timeout: 30000, // 30 seconds timeout
      });
      this.logger.logCodeQLCLI(command, "completed", stdout);
      if (stderr) {
        this.logger.warn("CodeQLService", "Pack installation warnings", stderr);
      }
    } catch (error) {
      this.logger.error(
        "CodeQLService",
        `Failed to install pack ${name}`,
        error
      );
      throw new Error(`Failed to install pack ${name}: ${error}`);
    }
  }

  private async createCodeQLDatabase(
    language: string,
    searchPaths: string[],
    repoName: string,
    workspaceFolder: string,
    codeqlDir: string,
    progress: vscode.Progress<{ increment?: number; message?: string }>,
    cancellationToken: vscode.CancellationToken
  ): Promise<string> {
    const config = vscode.workspace.getConfiguration("codeql-scanner");
    const codeqlPath = config.get<string>("codeqlPath", "codeql");

    const databasePath = this.getCodeQLDatabase(language);
    let source = this.getWorkspaceFolder();

    var command = `${codeqlPath} database create --overwrite -j 0 --language ${language} -s "${source}"`;
    // Add BMN
    if (language === "cpp" || language === "csharp" || language === "java") {
      command += ` --build-mode=none`;
    }
    command += ` "${databasePath}"`;

    this.logger.info("CodeQLService", `CodeQL Create Command: ${command}`);

    try {
      progress.report({ message: `Creating ${language} database...` });

      const { stdout, stderr } = await execAsync(command, {
        cwd: workspaceFolder,
        timeout: 300000, // 5 minutes timeout
      });

      this.logger.logCodeQLCLI(command, "completed", stdout);
      if (stderr) {
        this.logger.warn("CodeQLService", "Database creation warnings", stderr);
      }

      return databasePath;
    } catch (error) {
      throw new Error(
        `Failed to create CodeQL database for ${language}: ${error}`
      );
    }
  }

  private async analyzeCodeQLDatabase(
    databasePath: string,
    repoName: string,
    language: string,
    sha: string,
    codeqlDir: string,
    progress: vscode.Progress<{ increment?: number; message?: string }>,
    cancellationToken: vscode.CancellationToken
  ): Promise<any> {
    const config = vscode.workspace.getConfiguration("codeql-scanner");
    const codeqlPath = config.get<string>("codeqlPath", "codeql");
    const suites = config.get<Array<string>>("suites", ["default"]);
    const threatModel = config
      .get<string>("threatModel", "Remote")
      .toLowerCase();

    const outputPath = path.join(
      codeqlDir,
      "results",
      `${repoName}-${language}-${sha}.sarif`
    );

    // Build the query suite argument
    // var queries = `codeql/${language}-queries`;
    var queries = this.findQueryPack(language);
    this.logger.info(
      "CodeQLService",
      `Using query pack: ${queries} for language: ${language}`
    );
    if (!queries) {
      throw new Error(
        `No query pack found for language: ${language}. Please ensure the pack is installed.`
      );
    }

    const suite = suites[0];
    this.logger.info("CodeQLService", `Using suite: ${suite} for analysis`);
    if (
      suite === "code-scanning" ||
      suite === "security-extended" ||
      suite === "security-and-quality"
    ) {
      queries += `:codeql-suites/${language}-code-scanning.qls`;
    }

    var command = `${codeqlPath} database analyze -j 0 --output "${outputPath}" --format sarif-latest`;
    if (threatModel !== "remote") {
      command += ` --threat-model ${threatModel}`;
    }
    command += ` "${databasePath}" "${queries}"`;

    this.logger.info("CodeQLService", `CodeQL Analyze Command: ${command}`);

    try {
      progress.report({ message: "Running CodeQL analysis..." });

      const { stdout, stderr } = await execAsync(command, {
        timeout: 600000, // 10 minutes timeout
      });

      this.logger.logCodeQLCLI(command, "completed", stdout);
      if (stderr) {
        this.logger.warn("CodeQLService", "Analysis warnings", stderr);
      }

      // Read and parse the SARIF file
      const sarifContent = fs.readFileSync(outputPath, "utf8");
      return JSON.parse(sarifContent);
    } catch (error) {
      throw new Error(`Failed to analyze CodeQL database: ${error}`);
    }
  }

  private findQueryPack(language: string): string | undefined {
    const config = vscode.workspace.getConfiguration("codeql-scanner")
    const codeqlDir = this.getCodeQLDirectory();
    const queryPackPath = config.get<string>(
      "codeqlQueryPackPath",
      path.join(codeqlDir, "packages")
    );
    // const queryPackPath = path.join(codeqlDir, "packages");

    // List all directories in the packages folder
    if (!fs.existsSync(queryPackPath)) {
      this.logger.warn(
        "CodeQLService",
        `Query pack directory does not exist: ${queryPackPath}`
      );
      return undefined;
    }

    const orgDirs = fs.readdirSync(queryPackPath, { withFileTypes: true });
    for (const orgDir of orgDirs) {
      const orgPath = path.join(queryPackPath, orgDir.name);
      // codeql
      if (!orgDir.isDirectory()) {
        continue;
      }

      for (const packDir of fs.readdirSync(orgPath, { withFileTypes: true })) {
        if (packDir.isDirectory() && packDir.name === `${language}-queries`) {
          return `${orgDir.name}/${packDir.name}`;
        }
      }
    }
    return `codeql/${language}-queries`; // Fallback to default pack
  }

  private parseSARIFResults(
    sarif: any,
    workspaceFolder: string,
    language: string
  ): ScanResult[] {
    const results: ScanResult[] = [];

    if (!sarif.runs || sarif.runs.length === 0) {
      return results;
    }

    for (const run of sarif.runs) {
      if (!run.results) continue;

      let tool = run.tool || {};
      let driver = tool.driver || {};
      let rules = driver.rules || [];

      for (const result of run.results) {
        if (!result.locations || result.locations.length === 0) continue;

        const rule = rules.find((r: any) => r.id === result.ruleId);
        // Use sub-severity from rules if available, otherwise map severity
        const severity =
          this.mapSeverity(
            rule?.properties?.["security-severity"] || result.level
          ) || "medium";

        const location = result.locations[0];
        const physicalLocation = location.physicalLocation;

        if (!physicalLocation || !physicalLocation.artifactLocation) continue;

        const filePath = path.resolve(
          workspaceFolder,
          physicalLocation.artifactLocation.uri
        );
        const region = physicalLocation.region || {};

        // Extract flow steps from codeFlows if available
        const flowSteps: FlowStep[] = [];
        if (result.codeFlows && result.codeFlows.length > 0) {
          const codeFlow = result.codeFlows[0]; // Take the first code flow
          if (codeFlow.threadFlows && codeFlow.threadFlows.length > 0) {
            const threadFlow = codeFlow.threadFlows[0]; // Take the first thread flow
            if (threadFlow.locations) {
              threadFlow.locations.forEach(
                (flowLocation: any, index: number) => {
                  const flowPhysicalLocation =
                    flowLocation.location?.physicalLocation;
                  if (
                    flowPhysicalLocation &&
                    flowPhysicalLocation.artifactLocation
                  ) {
                    const flowFilePath = path.resolve(
                      workspaceFolder,
                      flowPhysicalLocation.artifactLocation.uri
                    );
                    const flowRegion = flowPhysicalLocation.region || {};

                    flowSteps.push({
                      file: flowFilePath,
                      startLine: flowRegion.startLine || 1,
                      startColumn: flowRegion.startColumn || 1,
                      endLine: flowRegion.endLine || flowRegion.startLine || 1,
                      endColumn:
                        flowRegion.endColumn || flowRegion.startColumn || 1,
                      message: flowLocation.message?.text,
                      stepIndex: index,
                    });
                  }
                }
              );
            }
          }
        }

        results.push({
          ruleId: result.ruleId || "unknown",
          severity: severity,
          message: result.message?.text || "No message",
          language: language,
          location: {
            file: filePath,
            startLine: region.startLine || 1,
            startColumn: region.startColumn || 1,
            endLine: region.endLine || region.startLine || 1,
            endColumn: region.endColumn || region.startColumn || 1,
          },
          flowSteps: flowSteps.length > 0 ? flowSteps : undefined,
        });
      }
    }

    return results;
  }

  private mapSeverity(level?: string): string | null {
    if (!level) return null;

    try {
      // Try and parse level as a number if it's a string
      const parseLevel = parseFloat(level);
      // Bit of a hack
      if (parseLevel >= 9.0) return "critical";
      else if (parseLevel >= 7.0) return "high";
      else if (parseLevel >= 5.0) return "medium";
      else if (parseLevel >= 3.0) return "low";
      else return "info";
    } catch (error) { }

    // Check if the level is a float
    switch (level?.toLowerCase()) {
      case "critical":
        return "critical";
      case "error":
        return "high";
      case "warning":
        return "medium";
      case "note":
      case "info":
        return "low";
      default:
        return "info";
    }
  }

  public async loadExistingSARIFFiles(): Promise<ScanResult[]> {
    this.logger.logServiceCall(
      "CodeQLService",
      "loadExistingSARIFFiles",
      "started"
    );

    try {
      const config = vscode.workspace.getConfiguration("codeql-scanner");
      const workspaceFolder = this.getWorkspaceFolder();
      const codeqlDir = this.getCodeQLDirectory();
      const repoName = this.getRepositoryName();

      const homeDir = process.env.HOME || process.env.USERPROFILE;
      if (!homeDir) {
        throw new Error("Could not determine home directory");
      }

      const resultsDir = path.join(codeqlDir, "results");
      this.logger.info("CodeQLService", `Results directory: ${resultsDir}`);

      // Check if results directory exists
      if (!fs.existsSync(resultsDir)) {
        this.logger.info(
          "CodeQLService",
          `Results directory does not exist: ${resultsDir}`
        );
        return [];
      }

      const allResults: ScanResult[] = [];

      // Get repository info from configuration
      const owner = config.get<string>("github.owner");
      const name = config.get<string>("github.repo");

      if (!owner || !name) {
        this.logger.warn(
          "CodeQLService",
          "Repository owner/name not configured, checking for any SARIF files"
        );

        // If repo info not configured, try to find any SARIF files that match pattern
        const files = fs.readdirSync(resultsDir);
        const sarifFiles = files.filter((file) => file.endsWith(".sarif"));

        this.logger.info(
          "CodeQLService",
          `Found ${sarifFiles.length} SARIF files in ${resultsDir}`
        );

        for (const file of sarifFiles) {
          const filePath = path.join(resultsDir, file);
          const language = this.extractLanguageFromFileName(file);

          if (language) {
            this.logger.info(
              "CodeQLService",
              `Loading SARIF file: ${file} (language: ${language})`
            );
            const results = await this.loadSARIFFile(
              filePath,
              workspaceFolder,
              language
            );
            allResults.push(...results);

            // Notify UI immediately when SARIF results are loaded
            if (this.resultsCallback && results.length > 0) {
              this.resultsCallback([...allResults]); // Send a copy of all results so far
            }
          } else {
            this.logger.warn(
              "CodeQLService",
              `Could not extract language from filename: ${file}`
            );
          }
        }
      } else {
        // Look for specific SARIF files matching the pattern
        const languages = config.get<string[]>("languages", []);

        if (languages.length === 0) {
          this.logger.warn(
            "CodeQLService",
            "No languages configured, cannot look for specific SARIF files"
          );
          return [];
        }

        let currentSHA: string;
        try {
          currentSHA = await this.getCurrentGitSHA();
        } catch (error) {
          this.logger.warn(
            "CodeQLService",
            "Could not get current Git SHA, trying to load any matching files"
          );
          // If we can't get SHA, try to find files without SHA matching
          const files = fs.readdirSync(resultsDir);
          const matchingFiles = files.filter(
            (file) =>
              file.startsWith(`${owner}-${name}-`) && file.endsWith(".sarif")
          );

          for (const file of matchingFiles) {
            const filePath = path.join(resultsDir, file);
            const language = this.extractLanguageFromFileName(file);

            if (language && languages.includes(language)) {
              this.logger.info(
                "CodeQLService",
                `Loading SARIF file: ${file} (language: ${language})`
              );
              const results = await this.loadSARIFFile(
                filePath,
                workspaceFolder,
                language
              );
              allResults.push(...results);

              // Notify UI immediately when SARIF results are loaded
              if (this.resultsCallback && results.length > 0) {
                this.resultsCallback([...allResults]); // Send a copy of all results so far
              }
            }
          }

          this.logger.logServiceCall(
            "CodeQLService",
            "loadExistingSARIFFiles",
            "completed",
            {
              resultCount: allResults.length,
            }
          );

          return allResults;
        }

        for (const language of languages) {
          const fileName = `${owner}-${name}-${language}-${currentSHA}.sarif`;
          const filePath = path.join(resultsDir, fileName);

          if (fs.existsSync(filePath)) {
            this.logger.info("CodeQLService", `Found SARIF file: ${fileName}`);
            const results = await this.loadSARIFFile(
              filePath,
              workspaceFolder,
              language
            );
            allResults.push(...results);

            // Notify UI immediately when SARIF results are loaded
            if (this.resultsCallback && results.length > 0) {
              this.resultsCallback([...allResults]); // Send a copy of all results so far
            }
          } else {
            this.logger.debug(
              "CodeQLService",
              `SARIF file not found: ${fileName}`
            );
          }
        }
      }

      this.logger.logServiceCall(
        "CodeQLService",
        "loadExistingSARIFFiles",
        "completed",
        {
          resultCount: allResults.length,
          filesChecked: resultsDir,
        }
      );

      return allResults;
    } catch (error) {
      this.logger.logServiceCall(
        "CodeQLService",
        "loadExistingSARIFFiles",
        "failed",
        error
      );
      throw error;
    }
  }

  private async loadSARIFFile(
    filePath: string,
    workspaceFolder: string,
    language: string
  ): Promise<ScanResult[]> {
    try {
      const sarifContent = fs.readFileSync(filePath, "utf8");
      const sarif = JSON.parse(sarifContent);
      return this.parseSARIFResults(sarif, workspaceFolder, language);
    } catch (error) {
      this.logger.error(
        "CodeQLService",
        `Failed to load SARIF file: ${filePath}`,
        error
      );
      return [];
    }
  }

  private extractLanguageFromFileName(fileName: string): string | null {
    // Extract language from filename pattern: owner-repo-lang-sha.sarif
    const parts = fileName.replace(".sarif", "").split("-");
    if (parts.length >= 3) {
      // Assume language is the third-to-last part before SHA
      return parts[parts.length - 2];
    }
    return null;
  }
}
